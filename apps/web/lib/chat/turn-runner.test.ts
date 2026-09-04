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
import { runChatTurn, type TurnInput, type TurnOutcome, type TurnStore } from './turn-runner';
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
    async heartbeat() {
      return cancelOnHeartbeat;
    },
    async finishTurn(result) {
      outcome = result;
    },
    async recordUsage(u) {
      usage.push(u.outputTokens);
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
});
