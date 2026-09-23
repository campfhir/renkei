/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * The loop's promises, against fakes: a plain reply completes the turn;
 * tool calls are run, fed back as a tool_results row, and answered by a
 * fresh assistant row; a cancel between chunks or between calls ends the
 * turn as canceled; the wall clock and the iteration cap end it as
 * interrupted / failed; a model error is reported in the person's words;
 * and every event the channel saw reassembles into the stored rows.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { LlmContentBlock, LlmProvider, LlmResponse, ResolvedLlm } from '@renkei/agent-llm';
import type { McpClient } from '@renkei/mcp-client';
import { createLocalToolSet, textResult, type LocalTool } from './local-tools';
import { openTurnChannel, resetTurnChannels, type TurnChannel } from './turn-events';
import {
  runChatTurn,
  toolGroups,
  type TurnInput,
  type TurnOutcome,
  type TurnStore,
} from './turn-runner';
import { applyStreamEvent, initialThreadState, type ThreadState } from './stream-events';
import type { ChatStreamEvent } from './stream-events';
import type { LocalToolContext } from './local-tools';

interface Row {
  id: string;
  seq: number;
  role: string;
  kind: string;
  status: string;
  blocks: LlmContentBlock[];
  error: string | null;
}

function fakeStore() {
  const rows = new Map<string, Row>();
  let seq = 1;
  let outcome: TurnOutcome | null = null;
  let cancelOnHeartbeat = false;
  const usage: number[] = [];
  const artifacts: { messageId: string; filename: string }[] = [];
  const stages: (string | null)[] = [];
  // The permission column: the ask the runner wrote, and the answer a
  // "route" (the test) writes into it for the poll to find.
  const asks: { toolUseId: string; name: string; messageId: string }[] = [];
  let pending: { toolUseId: string; decision: 'once' | 'always' | 'deny' | null } | null = null;
  let cleared = 0;
  const store: TurnStore = {
    async appendMessage(input) {
      seq += 1;
      const id = `m${seq}`;
      rows.set(id, {
        id,
        seq,
        role: input.role,
        kind: input.kind,
        status: input.status,
        blocks: input.blocks,
        error: null,
      });
      return { id, seq, createdAt: new Date(0) };
    },
    async flushAssistant(id, blocks, patch) {
      const row = rows.get(id) ?? {
        id,
        seq: 1,
        role: 'assistant',
        kind: 'assistant',
        status: 'streaming',
        blocks: [],
        error: null,
      };
      rows.set(id, {
        ...row,
        blocks,
        status: patch.status ?? row.status,
        error: patch.error === undefined ? row.error : patch.error,
      });
    },
    async heartbeat(_iterations, stage) {
      stages.push(stage);
      return cancelOnHeartbeat;
    },
    async finishTurn(result) {
      outcome = result;
    },
    async recordUsage(u) {
      usage.push(u.outputTokens);
    },
    async requestToolPermission(ask) {
      asks.push({ toolUseId: ask.toolUseId, name: ask.name, messageId: ask.messageId });
      pending = { toolUseId: ask.toolUseId, decision: null };
    },
    async readToolPermission(toolUseId) {
      return pending && pending.toolUseId === toolUseId ? pending.decision : null;
    },
    async clearToolPermission() {
      cleared += 1;
      pending = null;
    },
    async storeArtifacts(messageId, files) {
      artifacts.push(...files.map((file) => ({ messageId, filename: file.filename })));
      return files.map((file, index) => ({
        id: `artifact-${artifacts.length}-${index}`,
        filename: file.filename,
        contentType: file.mediaType,
        sizeBytes: file.dataBase64.length,
        extractStatus: 'none',
      }));
    },
  };
  return {
    store,
    rows,
    usage,
    artifacts,
    stages,
    asks,
    pending: () => pending,
    cleared: () => cleared,
    /** What the decision route does to the row, minus the channel. */
    decideOnRow(decision: 'once' | 'always' | 'deny') {
      if (pending) pending = { ...pending, decision };
    },
    outcome: () => outcome,
    setCancelOnHeartbeat(value: boolean) {
      cancelOnHeartbeat = value;
    },
  };
}

function provider(replies: LlmResponse[]): LlmProvider {
  let index = 0;
  return {
    async complete() {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return ok(reply);
    },
  };
}

function llmOf(p: LlmProvider): ResolvedLlm {
  return {
    provider: p,
    modelConfigId: 'model-1',
    providerName: 'anthropic',
    model: 'claude-x',
    maxOutputTokens: 4096,
  };
}

const text = (t: string): LlmResponse => ({
  content: [{ type: 'text', text: t }],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
});

const toolCall = (name: string, input: unknown): LlmResponse => ({
  content: [
    { type: 'thinking', thinking: 'let me check', signature: 'sig' },
    { type: 'tool_use', id: `tu_${name}`, name, input },
  ],
  stopReason: 'tool_use',
  usage: { inputTokens: 20, outputTokens: 8 },
});

/** A reply that said nothing: just a thought, no text and no tool call. */
const silentThinking = (
  thinking: string,
  stopReason: LlmResponse['stopReason'] = 'max_tokens'
): LlmResponse => ({
  content: [{ type: 'thinking', thinking, signature: 'sig' }],
  stopReason,
  usage: { inputTokens: 20, outputTokens: 4096 },
});

function fakeMcp(calls: string[]): McpClient {
  return {
    async initialize() {},
    async listTools() {
      return [];
    },
    async callTool(name, args) {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return { content: [{ type: 'text', text: `result of ${name}` }], isError: false, meta: {} };
    },
  };
}

const localContext: LocalToolContext = {
  // The fakes never touch it.
  db: null as unknown as LocalToolContext['db'],
  tenantId: 't',
  subject: 'u',
  chatId: 'c',
  projectId: null,
  readOnly: false,
};

function inputFor(turnId: string): TurnInput {
  return {
    turnId,
    assistantMessage: { id: 'm1', seq: 1, createdAt: new Date(0) },
    system: 'be helpful',
    history: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    thinkingBudget: null,
  };
}

/** Polls until `predicate` is true, instead of racing a fixed sleep against the flush timer. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function watch(channel: TurnChannel): { events: ChatStreamEvent[]; state: () => ThreadState } {
  const events: ChatStreamEvent[] = [];
  let state = initialThreadState([], null);
  channel.subscribe(0, ({ event }) => {
    events.push(event);
    state = applyStreamEvent(state, event);
  });
  return { events, state: () => state };
}

beforeEach(() => {
  resetTurnChannels();
});

describe('toolGroups', () => {
  const isRead = (use: string) => use.startsWith('r');

  it('batches consecutive reads up to the width and isolates every act', () => {
    expect(toolGroups(['r1', 'r2', 'a1', 'r3', 'a2', 'a3', 'r4'], isRead, 4)).toEqual([
      ['r1', 'r2'],
      ['a1'],
      ['r3'],
      ['a2'],
      ['a3'],
      ['r4'],
    ]);
    expect(toolGroups(['r1', 'r2', 'r3', 'r4', 'r5'], isRead, 2)).toEqual([
      ['r1', 'r2'],
      ['r3', 'r4'],
      ['r5'],
    ]);
  });

  it('runs everything alone at width 1 or with nothing vouched for', () => {
    expect(toolGroups(['r1', 'r2', 'a1'], isRead, 1)).toEqual([['r1'], ['r2'], ['a1']]);
    expect(toolGroups(['r1', 'r2'], () => false, 4)).toEqual([['r1'], ['r2']]);
    expect(toolGroups([], isRead, 4)).toEqual([]);
  });
});

describe('runChatTurn', () => {
  it('streams a plain reply into the assistant row and completes', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-1');
    const watched = watch(channel);
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([text('Hello there')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-1')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.outputTokens).toBe(5);
    expect(fake.rows.get('m1')?.status).toBe('complete');
    expect(fake.rows.get('m1')?.blocks).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(fake.outcome()?.status).toBe('completed');
    const state = watched.state();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].blocks).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(state.messages[0].status).toBe('complete');
    expect(state.turn?.status).toBe('completed');
    expect(channel.closed).toBe(true);
  });

  it('runs tool calls, stores the results row, and answers again', async () => {
    const fake = fakeStore();
    const calls: string[] = [];
    const channel = openTurnChannel('turn-2');
    const watched = watch(channel);
    const local: LocalTool = {
      def: { name: 'local_echo', description: 'echo', inputSchema: { type: 'object' } },
      async execute(input) {
        return textResult(`echo ${String(input.value)}`);
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(
          provider([
            toolCall('jira_search', { jql: 'a' }),
            toolCall('local_echo', { value: 1 }),
            text('Done'),
          ])
        ),
        tools: [{ name: 'jira_search', description: '', inputSchema: {} }],
        mcp: fakeMcp(calls),
        localTools: createLocalToolSet([local]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-2')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(3);
    expect(calls).toEqual(['jira_search:{"jql":"a"}']);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => `${row.role}/${row.kind}/${row.status}`)).toEqual([
      'assistant/assistant/complete',
      'user/tool_results/complete',
      'assistant/assistant/complete',
      'user/tool_results/complete',
      'assistant/assistant/complete',
    ]);
    expect(rows[1].blocks).toEqual([
      { type: 'tool_result', toolUseId: 'tu_jira_search', content: 'result of jira_search' },
    ]);
    expect(rows[3].blocks).toEqual([
      { type: 'tool_result', toolUseId: 'tu_local_echo', content: 'echo 1' },
    ]);
    // The thinking block is kept on the stored row (signature and all)...
    expect(rows[0].blocks[0]).toEqual({
      type: 'thinking',
      thinking: 'let me check',
      signature: 'sig',
    });
    // ...and the view reassembled from the stream matches, minus the signature.
    const state = watched.state();
    expect(state.messages).toHaveLength(5);
    expect(state.messages[0].blocks[0]).toEqual({ type: 'thinking', thinking: 'let me check' });
    expect(state.messages[0].blocks[1]).toEqual({
      type: 'tool_use',
      id: 'tu_jira_search',
      name: 'jira_search',
      input: { jql: 'a' },
    });
    expect(state.messages[4].blocks).toEqual([{ type: 'text', text: 'Done' }]);
    expect(watched.events.some((event) => event.type === 'tool_call_start')).toBe(true);
  });

  it('runs a prelude step before the model, kept and shown like a tool call', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-prelude');
    const watched = watch(channel);
    let ran = 0;
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([text('Cloned, and here is the answer')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      {
        ...inputFor('turn-prelude'),
        prelude: [
          {
            name: 'code_clone',
            input: { repository: 'acme/demo', branch: 'main' },
            async run() {
              ran += 1;
              return textResult('Cloned acme/demo @ main — 4.1 MB on the sandbox, 12s.');
            },
          },
        ],
      }
    );
    expect(outcome.status).toBe('completed');
    expect(ran).toBe(1);
    // One model call: the step is the runner's, not the model's.
    expect(outcome.iterations).toBe(1);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => `${row.role}/${row.kind}/${row.status}`)).toEqual([
      'assistant/assistant/complete',
      'user/tool_results/complete',
      'assistant/assistant/complete',
    ]);
    expect(rows[0].blocks).toEqual([
      {
        type: 'tool_use',
        id: expect.stringMatching(/^prelude_/),
        name: 'code_clone',
        input: { repository: 'acme/demo', branch: 'main' },
      },
    ]);
    expect(rows[1].blocks[0]).toMatchObject({
      type: 'tool_result',
      content: 'Cloned acme/demo @ main — 4.1 MB on the sandbox, 12s.',
    });
    expect(rows[2].blocks).toEqual([{ type: 'text', text: 'Cloned, and here is the answer' }]);
    // The stream showed the step pending, then its result, then the reply.
    const types = watched.events.map((event) => event.type);
    expect(types.indexOf('tool_call_start')).toBeGreaterThan(-1);
    expect(types.indexOf('tool_call_start')).toBeLessThan(types.lastIndexOf('message_start'));
    const state = watched.state();
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'code_clone' });
    expect(state.pendingToolCalls).toEqual([]);
  });

  it("adds a discovery tool result's discoveredTools to the active set for later turns", async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-2d');
    const requests: string[][] = [];
    const captureProvider: LlmProvider = {
      async complete(request) {
        requests.push(request.tools.map((tool) => tool.name));
        if (requests.length === 1) return ok(toolCall('find_tools', { query: 'jira' }));
        if (requests.length === 2) return ok(toolCall('jira_search_issues', { jql: 'a' }));
        return ok(text('Done'));
      },
    };
    const discover: LocalTool = {
      def: { name: 'find_tools', description: 'find tools', inputSchema: { type: 'object' } },
      readOnly: true,
      async execute() {
        return textResult('Found 1 tool(s), now callable:\n- jira_search_issues: search', {
          discoveredTools: [
            { name: 'jira_search_issues', description: 'search', inputSchema: { type: 'object' } },
          ],
        });
      },
    };
    const calls: string[] = [];
    const outcome = await runChatTurn(
      {
        llm: llmOf(captureProvider),
        tools: [{ name: 'find_tools', description: 'find tools', inputSchema: {} }],
        mcp: fakeMcp(calls),
        localTools: createLocalToolSet([discover]),
        localContext,
        readOnlyTools: new Set(['find_tools', 'jira_search_issues']),
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-2d')
    );
    expect(outcome.status).toBe('completed');
    // Round 1 offers only find_tools; round 2, after discovery, also offers
    // jira_search_issues — never sent up front, only once find_tools surfaced it.
    expect(requests[0]).toEqual(['find_tools']);
    expect(requests[1].sort()).toEqual(['find_tools', 'jira_search_issues']);
    expect(requests[2].sort()).toEqual(['find_tools', 'jira_search_issues']);
    expect(calls).toEqual(['jira_search_issues:{"jql":"a"}']);
  });

  it('offers a discoverable tool the model called from memory on the very next request', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-2r');
    const requests: string[][] = [];
    const captureProvider: LlmProvider = {
      async complete(request) {
        requests.push(request.tools.map((tool) => tool.name));
        // Remembered from an earlier turn, its schema absent — the kind of
        // call that arrives with an array sent as JSON text.
        if (requests.length === 1) {
          return ok(toolCall('outlook_create_event', { requiredAttendees: '["a@b.c"]' }));
        }
        if (requests.length === 2) {
          return ok(toolCall('outlook_create_event', { requiredAttendees: ['a@b.c'] }));
        }
        return ok(text('Done'));
      },
    };
    const calls: string[] = [];
    const outcome = await runChatTurn(
      {
        llm: llmOf(captureProvider),
        tools: [{ name: 'find_tools', description: 'find tools', inputSchema: {} }],
        mcp: fakeMcp(calls),
        localTools: createLocalToolSet([]),
        localContext,
        discoverableTools: [
          { name: 'outlook_create_event', description: 'create', inputSchema: { type: 'object' } },
        ],
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-2r')
    );
    expect(outcome.status).toBe('completed');
    // The first call still runs (the MCP server is the judge of its
    // arguments); the retry is made with the schema in the request.
    expect(calls).toEqual([
      'outlook_create_event:{"requiredAttendees":"[\\"a@b.c\\"]"}',
      'outlook_create_event:{"requiredAttendees":["a@b.c"]}',
    ]);
    expect(requests[0]).toEqual(['find_tools']);
    expect(requests[1].sort()).toEqual(['find_tools', 'outlook_create_event']);
  });

  it('runs read-only calls of a round together, acts alone, and keeps the order', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-2c');
    // Each call records when it started and finished against a shared
    // counter, so overlap is observable without timers.
    let clock = 0;
    const spans = new Map<string, { started: number; finished: number }>();
    const gates = new Map<string, () => void>();
    const mcp: McpClient = {
      async initialize() {},
      async listTools() {
        return [];
      },
      async callTool(name) {
        spans.set(name, { started: clock++, finished: -1 });
        await new Promise<void>((resolve) => gates.set(name, resolve));
        spans.get(name)!.finished = clock++;
        return { content: [{ type: 'text', text: `result of ${name}` }], isError: false, meta: {} };
      },
    };
    const reply: LlmResponse = {
      content: [
        { type: 'tool_use', id: 'tu_a', name: 'search_knowledge', input: { query: 'a' } },
        { type: 'tool_use', id: 'tu_b', name: 'jira_search_issues', input: { jql: 'b' } },
        { type: 'tool_use', id: 'tu_c', name: 'jira_create_issue', input: {} },
        { type: 'tool_use', id: 'tu_d', name: 'confluence_get_page', input: { id: 'd' } },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 8 },
    };
    const run = runChatTurn(
      {
        llm: llmOf(provider([reply, text('Done')])),
        tools: [],
        mcp,
        localTools: createLocalToolSet([]),
        localContext,
        readOnlyTools: new Set(['search_knowledge', 'jira_search_issues', 'confluence_get_page']),
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-2c')
    );
    // Both reads of the first group are in flight before either answers;
    // the act has not started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...gates.keys()].sort()).toEqual(['jira_search_issues', 'search_knowledge']);
    // Finishing them out of order changes nothing about the transcript.
    gates.get('jira_search_issues')!();
    gates.get('search_knowledge')!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gates.has('jira_create_issue')).toBe(true);
    expect(gates.has('confluence_get_page')).toBe(false);
    gates.get('jira_create_issue')!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    gates.get('confluence_get_page')!();
    const outcome = await run;

    expect(outcome.status).toBe('completed');
    const act = spans.get('jira_create_issue')!;
    expect(act.started).toBeGreaterThan(spans.get('search_knowledge')!.finished);
    expect(act.started).toBeGreaterThan(spans.get('jira_search_issues')!.finished);
    expect(spans.get('confluence_get_page')!.started).toBeGreaterThan(act.finished);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(
      rows[1].blocks.map((block) => (block.type === 'tool_result' ? block.toolUseId : ''))
    ).toEqual(['tu_a', 'tu_b', 'tu_c', 'tu_d']);
  });

  it('keeps the files a tool hands back and announces them on the stream', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-2b');
    const watched = watch(channel);
    const mcp: McpClient = {
      async initialize() {},
      async listTools() {
        return [];
      },
      async callTool() {
        return {
          content: [{ type: 'text', text: 'captured' }],
          isError: false,
          meta: {
            renkeiDocuments: [
              { mediaType: 'image/png', dataBase64: 'aGVsbG8=', title: 'page.png' },
              { mediaType: 'application/pdf', dataBase64: 'aGVsbG8=' },
            ],
          },
        };
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('sandbox_browser_screenshot', {}), text('Here you go')])),
        tools: [{ name: 'sandbox_browser_screenshot', description: '', inputSchema: {} }],
        mcp,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-2b')
    );
    expect(outcome.status).toBe('completed');
    const resultsRow = [...fake.rows.values()].find((row) => row.kind === 'tool_results');
    expect(fake.artifacts).toEqual([
      { messageId: resultsRow?.id, filename: 'page.png' },
      { messageId: resultsRow?.id, filename: 'sandbox_browser_screenshot-1-2.pdf' },
    ]);
    const announced = watched.events.filter((event) => event.type === 'artifact');
    expect(announced).toHaveLength(2);
    expect(watched.state().artifacts.map((artifact) => artifact.filename)).toEqual([
      'page.png',
      'sandbox_browser_screenshot-1-2.pdf',
    ]);
  });

  it('answers a tool the chat cannot reach with an error result rather than failing', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-3');
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('nowhere', {}), text('ok')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-3')
    );
    expect(outcome.status).toBe('completed');
    const results = [...fake.rows.values()].find((row) => row.kind === 'tool_results');
    expect(results?.blocks[0]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('stops as canceled when a cancel arrives between tool rounds', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-4');
    let calls = 0;
    const mcp: McpClient = {
      async initialize() {},
      async listTools() {
        return [];
      },
      async callTool() {
        calls += 1;
        channel.requestCancel();
        return { content: [{ type: 'text', text: 'x' }], isError: false, meta: {} };
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('a', {}), text('never')])),
        tools: [],
        mcp,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-4')
    );
    expect(calls).toBe(1);
    expect(outcome.status).toBe('canceled');
    expect(fake.outcome()?.status).toBe('canceled');
  });

  it('reports a model error in plain words and fails the turn', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-5');
    const failing: LlmProvider = {
      async complete() {
        return err('rate_limit' as const, { message: 'slow down' });
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(failing),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-5')
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/rate-limiting/);
    expect(fake.rows.get('m1')?.status).toBe('failed');
  });

  it('gives up after the iteration cap and the wall clock', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-6');
    const forever = provider([toolCall('a', {})]);
    const capped = await runChatTurn(
      {
        llm: llmOf(forever),
        tools: [],
        mcp: fakeMcp([]),
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5, maxIterations: 2 },
      },
      inputFor('turn-6')
    );
    expect(capped.status).toBe('failed');
    expect(capped.iterations).toBe(2);

    resetTurnChannels();
    let clock = 0;
    const late = await runChatTurn(
      {
        llm: llmOf(forever),
        tools: [],
        mcp: fakeMcp([]),
        localTools: createLocalToolSet([]),
        localContext,
        channel: openTurnChannel('turn-7'),
        store: fakeStore().store,
        now: () => (clock += 60_000),
        limits: { flushMs: 5, wallClockMs: 90_000 },
      },
      inputFor('turn-7')
    );
    expect(late.status).toBe('interrupted');
  });

  it('reports what it is doing on every heartbeat, so a stuck turn says where', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-stage');
    const model: { release: (() => void) | null } = { release: null };
    let modelCalls = 0;
    const slowProvider: LlmProvider = {
      async complete() {
        modelCalls += 1;
        if (modelCalls > 1) return ok(text('Done'));
        await new Promise<void>((resolve) => {
          model.release = resolve;
        });
        return ok(toolCall('agent_patch_steps', {}));
      },
    };
    const gates = new Map<string, () => void>();
    const mcp: McpClient = {
      async initialize() {},
      async listTools() {
        return [];
      },
      async callTool(name) {
        await new Promise<void>((resolve) => gates.set(name, resolve));
        return { content: [{ type: 'text', text: `result of ${name}` }], isError: false, meta: {} };
      },
    };
    const run = runChatTurn(
      {
        llm: llmOf(slowProvider),
        tools: [],
        mcp,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-stage')
    );
    // A heartbeat tick lands while the model call is still in flight.
    await waitUntil(() => fake.stages.includes('model'));
    model.release?.();
    // ...and again once the reply calls a tool.
    await waitUntil(() => fake.stages.includes('tool:agent_patch_steps'));
    gates.get('agent_patch_steps')!();
    await run;
  });

  it('times out a local tool that never settles, instead of hanging the turn', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-hang');
    const stuck: LocalTool = {
      def: { name: 'local_stuck', description: 'never returns', inputSchema: { type: 'object' } },
      execute: () => new Promise(() => {}),
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('local_stuck', {}), text('Recovered')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([stuck]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5, toolTimeoutMs: 20 },
      },
      inputFor('turn-hang')
    );
    expect(outcome.status).toBe('completed');
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    const results = rows.find((row) => row.kind === 'tool_results');
    expect(results?.blocks).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'tu_local_stuck',
        content: 'The tool could not be reached.',
        isError: true,
      },
    ]);
  });

  it("honors a local tool's own longer timeout over the turn's default", async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-patient');
    // The turn's own toolTimeoutMs is far too short for this tool, but the
    // tool declares its own budget — a sub-agent's, in the real code —
    // and the runner must race against THAT, not the turn's default, or
    // it abandons work that was always going to finish in time.
    const patient: LocalTool = {
      def: { name: 'local_patient', description: 'takes a while', inputSchema: { type: 'object' } },
      timeoutMs: 500,
      execute: () => new Promise((resolve) => setTimeout(() => resolve(textResult('done')), 50)),
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('local_patient', {}), text('Recovered')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([patient]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5, toolTimeoutMs: 10 },
      },
      inputFor('turn-patient')
    );
    expect(outcome.status).toBe('completed');
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    const results = rows.find((row) => row.kind === 'tool_results');
    expect(results?.blocks).toEqual([
      { type: 'tool_result', toolUseId: 'tu_local_patient', content: 'done' },
    ]);
  });
});

describe('runChatTurn permissions', () => {
  const act = (id: string, name = 'jira_create_issue'): LlmResponse => ({
    content: [{ type: 'tool_use', id, name, input: { summary: 'x' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 20, outputTokens: 8 },
  });
  const deps = (
    fake: ReturnType<typeof fakeStore>,
    channel: TurnChannel,
    replies: LlmResponse[],
    calls: string[],
    extra: Partial<Parameters<typeof runChatTurn>[0]> = {}
  ): Parameters<typeof runChatTurn>[0] => ({
    llm: llmOf(provider(replies)),
    tools: [],
    mcp: fakeMcp(calls),
    localTools: createLocalToolSet([]),
    localContext,
    readOnlyTools: new Set(['jira_search_issues']),
    permissions: { alwaysAllowed: new Set() },
    channel,
    store: fake.store,
    limits: { flushMs: 5, permissionPollMs: 10, permissionWaitMs: 5_000 },
    ...extra,
  });

  it('asks before a call that acts, and runs it once allowed through the channel', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p1');
    const watched = watch(channel);
    const calls: string[] = [];
    const run = runChatTurn(
      deps(fake, channel, [act('tu_1'), text('Filed')], calls),
      inputFor('turn-p1')
    );
    await waitUntil(() => fake.asks.length === 1);
    expect(fake.asks[0]).toEqual({ toolUseId: 'tu_1', name: 'jira_create_issue', messageId: 'm1' });
    expect(watched.state().pendingPermission).toMatchObject({
      toolUseId: 'tu_1',
      name: 'jira_create_issue',
      messageId: 'm1',
    });
    // Nothing has run, and the stream says the call is waiting, not running.
    expect(calls).toEqual([]);
    expect(watched.state().pendingToolCalls).toEqual([]);
    channel.resolveToolPermission('tu_1', 'once');
    const outcome = await run;
    expect(outcome.status).toBe('completed');
    expect(calls).toEqual(['jira_create_issue:{"summary":"x"}']);
    expect(fake.cleared()).toBe(1);
    expect(watched.state().pendingPermission).toBeNull();
    const decided = watched.events.find((event) => event.type === 'tool_permission_decided');
    expect(decided).toMatchObject({ toolUseId: 'tu_1', decision: 'once' });
  });

  it('never asks for a read, or for a tool on the always-allowed list', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p2');
    const calls: string[] = [];
    const outcome = await runChatTurn(
      deps(
        fake,
        channel,
        [act('tu_r', 'jira_search_issues'), act('tu_w', 'webex_send_message'), text('Done')],
        calls,
        { permissions: { alwaysAllowed: new Set(['webex_send_message']) } }
      ),
      inputFor('turn-p2')
    );
    expect(outcome.status).toBe('completed');
    expect(fake.asks).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('refuses a blocked tool without asking, even when the model calls it from memory', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p2b');
    const watched = watch(channel);
    const calls: string[] = [];
    const outcome = await runChatTurn(
      deps(fake, channel, [act('tu_1', 'jira_delete_issue'), text('Understood')], calls, {
        permissions: { alwaysAllowed: new Set(), denied: new Set(['jira_delete_issue']) },
      }),
      inputFor('turn-p2b')
    );
    expect(outcome.status).toBe('completed');
    expect(fake.asks).toEqual([]);
    expect(calls).toEqual([]);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows[1].blocks[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu_1',
      isError: true,
      content: expect.stringContaining('blocked'),
    });
    expect(watched.events.some((event) => event.type === 'tool_permission_request')).toBe(false);
  });

  it('runs nothing unasked when no permission policy is given', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p3');
    const calls: string[] = [];
    const outcome = await runChatTurn(
      deps(fake, channel, [act('tu_1'), text('Done')], calls, { permissions: undefined }),
      inputFor('turn-p3')
    );
    expect(outcome.status).toBe('completed');
    expect(fake.asks).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('remembers "always" for the rest of the turn', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p4');
    const calls: string[] = [];
    const run = runChatTurn(
      deps(fake, channel, [act('tu_1'), act('tu_2'), text('Done')], calls),
      inputFor('turn-p4')
    );
    await waitUntil(() => fake.asks.length === 1);
    channel.resolveToolPermission('tu_1', 'always');
    const outcome = await run;
    expect(outcome.status).toBe('completed');
    expect(fake.asks).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('feeds the model a refusal instead of running a denied call', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p5');
    const watched = watch(channel);
    const calls: string[] = [];
    const run = runChatTurn(
      deps(fake, channel, [act('tu_1'), text('Understood')], calls),
      inputFor('turn-p5')
    );
    await waitUntil(() => fake.asks.length === 1);
    // Answered on the row alone — another replica's route — and found by the poll.
    fake.decideOnRow('deny');
    const outcome = await run;
    expect(outcome.status).toBe('completed');
    expect(calls).toEqual([]);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows[1].blocks[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu_1',
      isError: true,
      content: expect.stringContaining('declined'),
    });
    expect(watched.events.some((event) => event.type === 'tool_call_start')).toBe(false);
  });

  it('retries a model call that fails before any output right after a denial', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p5b');
    const calls: string[] = [];
    let modelCalls = 0;
    // The reply that follows the tool round is a pooled connection's first
    // use since the ask started — exactly what a gateway between us and
    // the provider tends to have quietly dropped by the time a person
    // actually gets to Deny. It fails outright, before a single byte
    // reaches the channel; the runner should retry it rather than fail
    // the whole turn over a refusal the person just answered correctly.
    const staleThenFine: LlmProvider = {
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) return ok(act('tu_1'));
        if (modelCalls === 2) return err('network' as const, { message: 'stale connection' });
        return ok(text('Understood'));
      },
    };
    const run = runChatTurn(
      deps(fake, channel, [], calls, { llm: llmOf(staleThenFine) }),
      inputFor('turn-p5b')
    );
    await waitUntil(() => fake.asks.length === 1);
    fake.decideOnRow('deny');
    const outcome = await run;
    expect(outcome.status).toBe('completed');
    expect(modelCalls).toBe(3);
    expect(calls).toEqual([]);
  });

  it('gives up waiting when the permission budget runs out, without failing the turn', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p6');
    const calls: string[] = [];
    const outcome = await runChatTurn(
      deps(fake, channel, [act('tu_1'), text('Noted')], calls, {
        limits: { flushMs: 5, permissionPollMs: 10, permissionWaitMs: 30 },
      }),
      inputFor('turn-p6')
    );
    expect(outcome.status).toBe('completed');
    expect(calls).toEqual([]);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows[1].blocks[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
      content: expect.stringContaining('in time'),
    });
    expect(fake.pending()).toBeNull();
  });

  it('does not count the wait against the wall clock', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p7');
    const calls: string[] = [];
    let clock = 0;
    const run = runChatTurn(
      deps(fake, channel, [act('tu_1'), text('Done')], calls, {
        now: () => clock,
        limits: { flushMs: 5, permissionPollMs: 10, permissionWaitMs: 5_000, wallClockMs: 100 },
      }),
      inputFor('turn-p7')
    );
    await waitUntil(() => fake.asks.length === 1);
    // An hour passes while the person is away, then they allow it.
    clock = 3_600_000;
    channel.resolveToolPermission('tu_1', 'once');
    const outcome = await run;
    expect(outcome.status).toBe('completed');
    expect(calls).toHaveLength(1);
  });

  it('ends as canceled when Stop arrives while waiting', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-p8');
    const calls: string[] = [];
    const run = runChatTurn(
      deps(fake, channel, [act('tu_1'), text('Done')], calls),
      inputFor('turn-p8')
    );
    await waitUntil(() => fake.asks.length === 1);
    channel.requestCancel();
    const outcome = await run;
    expect(outcome.status).toBe('canceled');
    expect(calls).toEqual([]);
    expect(fake.pending()).toBeNull();
  });
});

describe('runChatTurn on a reply that said nothing', () => {
  it('retries a thinking-only max_tokens reply instead of finishing on it', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-trunc-1');
    const watched = watch(channel);
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([silentThinking('still working through it...'), text('Here you go.')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-trunc-1')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(2);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => `${row.role}:${row.kind}`)).toEqual([
      'assistant:assistant',
      'user:nudge',
      'assistant:assistant',
    ]);
    const state = watched.state();
    expect(state.messages.map((message) => message.kind)).toEqual([
      'assistant',
      'nudge',
      'assistant',
    ]);
    expect(state.messages[2].blocks).toEqual([{ type: 'text', text: 'Here you go.' }]);
  });

  it('retries a thinking-only reply that stopped naturally too, not only on max_tokens', async () => {
    // The model can decide to stop right after thinking, with an
    // ordinary end_turn — the person still gets nothing to read, and
    // this happened turn after turn (each needing a fresh "continue"
    // from the person) before this fix, not just once mid-thought.
    const fake = fakeStore();
    const channel = openTurnChannel('turn-trunc-1b');
    const outcome = await runChatTurn(
      {
        llm: llmOf(
          provider([silentThinking('let me think about this...', 'end_turn'), text('Here you go.')])
        ),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-trunc-1b')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(2);
    const nudges = [...fake.rows.values()].filter((row) => row.kind === 'nudge');
    expect(nudges).toHaveLength(1);
  });

  it('gives up after MAX_SILENT_RETRIES and finishes the turn as it stands', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-trunc-2');
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([silentThinking('thinking...')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-trunc-2')
    );
    expect(outcome.status).toBe('completed');
    // The first reply plus one retry per MAX_SILENT_RETRIES (2), then it
    // stops trying and completes on the last (still empty) reply.
    expect(outcome.iterations).toBe(3);
    const nudges = [...fake.rows.values()].filter((row) => row.kind === 'nudge');
    expect(nudges).toHaveLength(2);
  });

  it('does not retry a max_tokens reply that already said something', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-trunc-3');
    const outcome = await runChatTurn(
      {
        llm: llmOf(
          provider([
            {
              content: [{ type: 'text', text: 'Here is what I have so far, cut off mid-' }],
              stopReason: 'max_tokens',
              usage: { inputTokens: 20, outputTokens: 4096 },
            },
          ])
        ),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-trunc-3')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(1);
    expect([...fake.rows.values()].some((row) => row.kind === 'nudge')).toBe(false);
  });
});

describe('runChatTurn on a request that fails mid-argument-stream', () => {
  it('keeps the partial JSON on the persisted block instead of a blank input', async () => {
    // A real provider streams a tool call's arguments piece by piece
    // (block_start with an empty `{}` placeholder, then input_json_delta
    // chunks) before the request as a whole resolves. If the request
    // fails or drops after the arguments finished streaming but before
    // the provider signals the call is done, the runner must not have
    // discarded what it already saw.
    const fake = fakeStore();
    const channel = openTurnChannel('turn-partial-1');
    const droppedMidStream: LlmProvider = {
      async complete() {
        throw new Error('not used — this test drives stream() directly');
      },
      async stream(_request, options) {
        options.onEvent({ type: 'message_start' });
        options.onEvent({
          type: 'block_start',
          index: 0,
          block: { type: 'tool_use', id: 'tu_1', name: 'agent_patch_steps', input: {} },
        });
        options.onEvent({ type: 'input_json_delta', index: 0, partialJson: '{"name": "Test' });
        options.onEvent({ type: 'input_json_delta', index: 0, partialJson: 'Step"}' });
        // The connection drops here — no block_stop, no message_end.
        return err('network' as const);
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(droppedMidStream),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-partial-1')
    );
    expect(outcome.status).toBe('failed');
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    expect(rows[0].blocks[0]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'agent_patch_steps',
      input: {},
      partialJson: '{"name": "TestStep"}',
    });
  });
});

describe('runChatTurn on a tool call cut off by the output-token ceiling', () => {
  it('refuses the call with a clear reason instead of silently ending the turn on it', async () => {
    // Unlike the mid-stream drop above, the request itself completes: the
    // model simply ran out of room while still emitting this call's JSON.
    // The accumulator (stream-accumulator.ts) resolves that the lenient
    // way, same as a genuinely empty-input call — `{}` — so the only
    // telltale is the raw partialJson the mirror saw stream by, which
    // never parses. Left unhandled, `toolUses.length > 0` but
    // `stopReason !== 'tool_use'` used to skip the tool round outright:
    // the call was never run AND never refused, so the turn just ended
    // as if nothing had been asked.
    const fake = fakeStore();
    const channel = openTurnChannel('turn-truncated-1');
    let calls = 0;
    const cutOffMidCall: LlmProvider = {
      async complete() {
        throw new Error('not used — this test drives stream() directly');
      },
      async stream(_request, options) {
        calls += 1;
        if (calls === 1) {
          options.onEvent({ type: 'message_start' });
          options.onEvent({
            type: 'block_start',
            index: 0,
            block: { type: 'tool_use', id: 'tu_big', name: 'agent_create', input: {} },
          });
          options.onEvent({
            type: 'input_json_delta',
            index: 0,
            partialJson: '{"name": "Big Agent", "steps": [{"id": "s1"',
          });
          // No block_stop for this block — the provider hit its output
          // ceiling mid-argument and went straight to message_end.
          const usage = { inputTokens: 10, outputTokens: 500 };
          options.onEvent({ type: 'message_end', stopReason: 'max_tokens', usage });
          return ok({
            content: [{ type: 'tool_use', id: 'tu_big', name: 'agent_create', input: {} }],
            stopReason: 'max_tokens' as const,
            usage,
          });
        }
        // Retried, told why, and this time it fits: a normal reply.
        const usage = { inputTokens: 10, outputTokens: 5 };
        options.onEvent({ type: 'message_start' });
        options.onEvent({ type: 'block_start', index: 0, block: { type: 'text', text: '' } });
        options.onEvent({ type: 'text_delta', index: 0, text: 'Retrying smaller.' });
        options.onEvent({ type: 'block_stop', index: 0 });
        options.onEvent({ type: 'message_end', stopReason: 'end_turn', usage });
        return ok({
          content: [{ type: 'text', text: 'Retrying smaller.' }],
          stopReason: 'end_turn' as const,
          usage,
        });
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(cutOffMidCall),
        tools: [{ name: 'agent_create', description: '', inputSchema: {} }],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-truncated-1')
    );
    expect(outcome.status).toBe('completed');
    const results = [...fake.rows.values()].find((row) => row.kind === 'tool_results');
    expect(results?.blocks[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu_big',
      isError: true,
      content: expect.stringContaining('cut off'),
    });
  });
});

describe('runChatTurn logs every tool call attempt', () => {
  it('logs the attempt and outcome at debug, whether the call ran or was refused', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-log-1');
    const calls: string[] = [];
    const logged: { message: string; fields: Record<string, unknown>; level?: string }[] = [];
    const echo: LocalTool = {
      def: { name: 'local_echo', description: 'echo', inputSchema: { type: 'object' } },
      async execute(input) {
        return textResult(`echo ${String(input.value)}`);
      },
    };
    const run = runChatTurn(
      {
        llm: llmOf(
          provider([
            toolCall('jira_create_issue', { summary: 'x' }),
            toolCall('local_echo', { value: 1 }),
            text('Done'),
          ])
        ),
        tools: [{ name: 'jira_create_issue', description: '', inputSchema: {} }],
        mcp: fakeMcp(calls),
        localTools: createLocalToolSet([echo]),
        localContext,
        // jira_create_issue is not in readOnlyTools, so it needs asking —
        // deny it to exercise the refused path in the same test.
        permissions: { alwaysAllowed: new Set(), denied: new Set() },
        readOnlyTools: new Set(['local_echo']),
        channel,
        store: fake.store,
        log: (message, fields, level) => logged.push({ message, fields, level }),
        limits: { flushMs: 5, permissionWaitMs: 10_000, permissionPollMs: 5 },
      },
      inputFor('turn-log-1')
    );
    // Deny the ask as soon as it appears.
    await waitUntil(() => fake.asks.length === 1);
    fake.decideOnRow('deny');
    await run;
    const byMessage = (needle: string) => logged.filter((row) => row.message.includes(needle));
    const refused = byMessage('chat tool call refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ level: 'debug', fields: { tool: 'jira_create_issue' } });
    const attempts = byMessage('chat tool call:');
    expect(attempts.map((row) => row.fields.tool)).toEqual(['local_echo']);
    expect(attempts[0]).toMatchObject({ level: 'debug', fields: { local: true } });
    const outcomes = byMessage('chat tool call outcome');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      level: 'debug',
      fields: { tool: 'local_echo', isError: false },
    });
  });
});

describe('runChatTurn logs the actual request on a model error', () => {
  it('attaches the plain-text, redacted-nowhere request body — not just the error kind/message', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-log-model-error');
    const logged: { message: string; fields: Record<string, unknown>; level?: string }[] = [];
    const rejecting: LlmProvider = {
      async complete() {
        return err('invalid_request' as const, {
          message: 'OpenAI-compatible endpoint 400: bad request',
          cause: {
            summary: 'POST https://x/y\n{"model":"<redacted>"}',
            url: 'https://api.openai.com/v1/chat/completions',
            headers: { authorization: 'Bearer sk-real-secret', 'content-type': 'application/json' },
            request: { model: 'gpt-6-astra-1', messages: [{ role: 'user', content: 'hi' }] },
          },
        });
      },
    };
    const outcome = await runChatTurn(
      {
        llm: llmOf(rejecting),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([]),
        localContext,
        channel,
        store: fake.store,
        log: (message, fields, level) => logged.push({ message, fields, level }),
        limits: { flushMs: 5 },
      },
      inputFor('turn-log-model-error')
    );
    expect(outcome.status).toBe('failed');
    const errorLog = logged.find((row) => row.message.includes('chat turn model error'));
    expect(errorLog).toMatchObject({ level: 'error', fields: { kind: 'invalid_request' } });
    // Plain text, not secure() — no credential ever lives in a request
    // body, so there is nothing here worth the encrypt-at-rest treatment.
    const requestField = errorLog?.fields.request;
    expect(typeof requestField).toBe('string');
    const parsed: { model?: unknown; messages?: unknown } = JSON.parse(
      typeof requestField === 'string' ? requestField : '{}'
    );
    expect(parsed.model).toBe('gpt-6-astra-1');
    expect(Array.isArray(parsed.messages)).toBe(true);

    // The URL rides plain; the credential-bearing header is masked, every
    // other header is plain.
    expect(errorLog?.fields.url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = errorLog?.fields.headers as
      | { authorization?: { _secure?: boolean; value?: string }; 'content-type'?: unknown }
      | undefined;
    expect(headers?.authorization?._secure).toBe(true);
    expect(headers?.authorization?.value).toBe('Bearer sk-real-secret');
    expect(headers?.['content-type']).toBe('application/json');
  });
});

describe('runChatTurn in auto mode', () => {
  const doneTool: LocalTool = {
    def: { name: 'task_complete', description: 'done', inputSchema: { type: 'object' } },
    readOnly: true,
    async execute() {
      return textResult('Noted.');
    },
  };
  const autoContinue = {
    doneTool: 'task_complete',
    nudge: 'Carry on.',
    maxContinues: 3,
    subagentTool: 'code_delegate',
  };
  const delegateTool: LocalTool = {
    def: {
      name: 'code_delegate',
      description: 'delegate to a sub-agent',
      inputSchema: { type: 'object' },
    },
    readOnly: true,
    async execute() {
      return textResult('Sub-agent done.');
    },
  };
  const lookTool: LocalTool = {
    def: { name: 'local_look', description: 'look around', inputSchema: { type: 'object' } },
    readOnly: true,
    async execute() {
      return textResult('nothing yet');
    },
  };

  it('nudges the model on when a reply ends without task_complete, then completes once it is called', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-auto-1');
    const watched = watch(channel);
    const outcome = await runChatTurn(
      {
        llm: llmOf(
          provider([
            toolCall('code_delegate', {}),
            text('Still working on it.'),
            toolCall('task_complete', { outcome: 'done', summary: 'All done.' }),
            text('Finished: the tests pass.'),
          ])
        ),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([doneTool, delegateTool]),
        localContext,
        autoContinue,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-auto-1')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(4);
    const rows = [...fake.rows.values()].sort((a, b) => a.seq - b.seq);
    // The first reply (a tool call), its result, the reply that stops
    // without finishing, the nudge in the person's place, the reply that
    // called task_complete, its result, and the final reply.
    expect(rows.map((row) => `${row.role}:${row.kind}`)).toEqual([
      'assistant:assistant',
      'user:tool_results',
      'assistant:assistant',
      'user:nudge',
      'assistant:assistant',
      'user:tool_results',
      'assistant:assistant',
    ]);
    expect(rows[3].blocks).toEqual([{ type: 'text', text: 'Carry on.' }]);
    expect(rows[6].blocks).toEqual([{ type: 'text', text: 'Finished: the tests pass.' }]);
    const state = watched.state();
    expect(state.messages.map((message) => message.kind)).toEqual([
      'assistant',
      'tool_results',
      'assistant',
      'nudge',
      'assistant',
      'tool_results',
      'assistant',
    ]);
    expect(state.messages[3].blocks).toEqual([{ type: 'text', text: 'Carry on.' }]);
    expect(state.turn?.status).toBe('completed');
  });

  it('does not nudge a reply that never touched a tool — a plain answer, not unfinished work', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-auto-1b');
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([text('No, those are gitignored; only the tests are committed.')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([doneTool, lookTool]),
        localContext,
        autoContinue,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-auto-1b')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(1);
    expect([...fake.rows.values()].some((row) => row.kind === 'nudge')).toBe(false);
  });

  it('gives up after maxContinues nudges and completes the turn as it stands', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-auto-2');
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('code_delegate', {}), text('Still thinking about it.')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([doneTool, delegateTool]),
        localContext,
        autoContinue,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-auto-2')
    );
    expect(outcome.status).toBe('completed');
    // The sub-agent call, its result, the reply plus one per nudge.
    expect(outcome.iterations).toBe(5);
    const nudges = [...fake.rows.values()].filter((row) => row.kind === 'nudge');
    expect(nudges).toHaveLength(3);
  });

  it('does not nudge a turn that only called ordinary tools, never a sub-agent', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-auto-2b');
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([toolCall('local_look', {}), text('Looked around; all set.')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([doneTool, delegateTool, lookTool]),
        localContext,
        autoContinue,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-auto-2b')
    );
    expect(outcome.status).toBe('completed');
    // The tool call, its result, and the final reply — no nudge in between.
    expect(outcome.iterations).toBe(2);
    expect([...fake.rows.values()].some((row) => row.kind === 'nudge')).toBe(false);
  });

  it('does not nudge a turn that was stopped, and never without autoContinue', async () => {
    const fake = fakeStore();
    const channel = openTurnChannel('turn-auto-3');
    const outcome = await runChatTurn(
      {
        llm: llmOf(provider([text('Not done, but no auto mode.')])),
        tools: [],
        mcp: null,
        localTools: createLocalToolSet([doneTool]),
        localContext,
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-auto-3')
    );
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(1);
    expect([...fake.rows.values()].some((row) => row.kind === 'nudge')).toBe(false);
  });

  it('runs act tools without asking under allowAll, and still refuses a blocked one', async () => {
    const fake = fakeStore();
    const calls: string[] = [];
    const channel = openTurnChannel('turn-auto-4');
    const outcome = await runChatTurn(
      {
        llm: llmOf(
          provider([
            toolCall('jira_create_issue', { summary: 'x' }),
            toolCall('outlook_send_mail', { to: 'a' }),
            text('Done'),
          ])
        ),
        tools: [],
        mcp: fakeMcp(calls),
        localTools: createLocalToolSet([]),
        localContext,
        permissions: {
          alwaysAllowed: new Set(),
          denied: new Set(['outlook_send_mail']),
          allowAll: true,
        },
        channel,
        store: fake.store,
        limits: { flushMs: 5 },
      },
      inputFor('turn-auto-4')
    );
    expect(outcome.status).toBe('completed');
    expect(fake.asks).toEqual([]);
    expect(calls).toEqual(['jira_create_issue:{"summary":"x"}']);
    const refusal = [...fake.rows.values()]
      .filter((row) => row.kind === 'tool_results')
      .flatMap((row) => row.blocks)
      .find((block) => block.type === 'tool_result' && block.toolUseId === 'tu_outlook_send_mail');
    expect(refusal && refusal.type === 'tool_result' ? refusal.isError : null).toBe(true);
  });
});
