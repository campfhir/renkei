/**
 * The engine and the action executor against a real database (skipped
 * without DATABASE_URL) and a scripted model/MCP pair. What must hold:
 *
 *  - the agent works autonomously — reads, retries after a failed call,
 *    and ends with finish_run; every model turn is a sealed row;
 *  - it can never call an act tool: the model's token carries read tools
 *    only, and a direct call is refused with a pointer to stage_actions;
 *  - staged actions wait on one card for the whole batch (or are
 *    auto-accepted where the org allows), are executed by the separate
 *    executor in order, stop at the first failure, and come back to the
 *    agent as the stage_actions result;
 *  - the tool budget and the ACTIVE-time limit are hard, and time spent
 *    waiting on a person is not counted;
 *  - a crash, a stop, a pause or a resume re-enters exactly where the run
 *    was, never making a call twice.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB, type Json } from '@renkei/db';
import { ok } from '@campfhir/safe-functions/helpers';
import {
  messagesChars,
  type LlmRequest,
  type LlmResponse,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import {
  RUN_COMPACTION_SYSTEM,
  mergeOpenedDetail,
  sealedDetailOf,
  type AgentDefinition,
} from '@renkei/agents';
import { setOrgSettings } from '@renkei/settings';
import { resumeAgentRun } from '@renkei/agents/runs';
import type { QueueMessageInput, QueueProducer } from '@renkei/queue';
import { MessageReleased } from '@renkei/worker-loop';
import { createAgentRunHandler, TURN_STEP_ID, type FinalizedRun } from './engine';
import { createActionsHandler } from './actions';
import type { McpClient, McpToolResult } from './mcp-client';

let ownerDelegated = true;
const FAKE_SEAL = 'uenc1:test:';
const fakeSeal = (value: string): string =>
  FAKE_SEAL + Buffer.from(value, 'utf8').toString('base64');
const fakeOpen = (stored: string): string | null =>
  stored.startsWith(FAKE_SEAL)
    ? Buffer.from(stored.slice(FAKE_SEAL.length), 'base64').toString('utf8')
    : null;
jest.mock('@renkei/delegate-client', () => ({
  delegateClient: () => ({
    sealForSubject: stubSealForSubject,
    openForSubject: stubOpenForSubject,
    keyStatus: stubKeyStatus,
    forRun: () => ({ keyStatus: stubKeyStatus }),
  }),
}));
const stubKeyStatus = async () => ({
  ok: true,
  val: {
    enrolled: true,
    sessionInstances: [],
    automationInstances: ownerDelegated ? ['instance-1'] : [],
  },
});
const stubSealForSubject = async (_subject: string, values: string[]) => ({
  ok: true,
  val: values.map(fakeSeal),
});
const stubOpenForSubject = async (_subject: string, stored: string[]) => ({
  ok: true,
  val: stored.map(fakeOpen),
});

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

type Scripted = (request: LlmRequest, call: number) => LlmResponse;

function stubLlm(script: Scripted): ResolvedLlm & { requests: LlmRequest[] } {
  let calls = 0;
  const requests: LlmRequest[] = [];
  return {
    requests,
    provider: {
      complete: async (request) => {
        requests.push(request);
        const response = script(request, calls);
        calls += 1;
        return ok(response);
      },
    },
    modelConfigId: randomUUID(),
    providerName: 'anthropic',
    model: 'stub-model',
    maxOutputTokens: 512,
  };
}

let toolUseSeq = 0;
const call = (name: string, input: Record<string, unknown> = {}): LlmResponse => ({
  content: [{ type: 'tool_use', id: `tu_${(toolUseSeq += 1)}`, name, input }],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
});
const finish = (
  outcome: 'done' | 'nothing_to_do' | 'failed',
  extra: Record<string, unknown> = {}
): LlmResponse => call('finish_run', { outcome, summary: `declared ${outcome}`, ...extra });

const READS = ['jira_get_issue', 'jira_search_issues'];

/** Tools as the gateway lists them for a token: only those the token names. */
function stubMcp(
  named: string[],
  callTool: (name: string, args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>,
  calls: { name: string; args: Record<string, unknown> }[]
): McpClient {
  return {
    initialize: async () => undefined,
    listTools: async () =>
      named.map((name) => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object' },
        kind: READS.includes(name) ? ('read' as const) : ('act' as const),
      })),
    callTool: async (name, args) => {
      if (!named.includes(name)) throw new Error(`token does not name ${name}`);
      calls.push({ name, args });
      return callTool(name, args);
    },
  };
}

const text = (body: string, isError = false): McpToolResult => ({
  content: [{ type: 'text', text: body }],
  isError,
  meta: {},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsealed(detail: unknown): Record<string, unknown> {
  const envelope = sealedDetailOf(detail);
  const merged =
    envelope === null ? detail : mergeOpenedDetail(detail, fakeOpen(envelope), '[locked]');
  return isRecord(merged) ? merged : {};
}

/** The tool_result text the model was last sent for a given tool_use id. */
function resultFor(request: LlmRequest, toolUseId: string): string | undefined {
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.toolUseId === toolUseId) return block.content;
    }
  }
  return undefined;
}

function lastToolUseId(request: LlmRequest): string {
  const assistant = [...request.messages].reverse().find((message) => message.role === 'assistant');
  const use = assistant?.content.find((block) => block.type === 'tool_use');
  if (!use || use.type !== 'tool_use') throw new Error('no tool use');
  return use.id;
}

class CapturingProducer implements QueueProducer {
  readonly messages: QueueMessageInput[] = [];
  async enqueue(message: QueueMessageInput) {
    this.messages.push(message);
    return ok(undefined);
  }
  /** The payloads of every message of this type, removed from the capture. */
  take(type: string): { payload: Json }[] {
    const taken = this.messages.filter((message) => message.type === type);
    this.messages.splice(0, this.messages.length, ...this.messages.filter((m) => m.type !== type));
    // The engine's payloads are JSON by construction; round-trip to say so.
    return taken.map((message) => ({ payload: JSON.parse(JSON.stringify(message.payload)) }));
  }
}

maybe('agent run engine', () => {
  jest.setTimeout(30_000);

  let db: Kysely<DB>;
  const suiteId = randomUUID();
  const subject = `engine-subject-${suiteId.slice(0, 8)}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('identities')
      .values({ subject, email: 'owner@example.com', display_name: 'Test Owner' })
      .execute();
    await setOrgSettings({
      agentRunTimeoutMinutes: 30,
      agentRunToolCallBudget: 150,
      agentActStepsRequireApproval: 'externally_triggered',
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM actionable_items WHERE owner_subject = ${subject}`.execute(db);
    await sql`DELETE FROM agent_notifications WHERE subject = ${subject}`.execute(db);
    await sql`DELETE FROM agent_runs WHERE owner_subject = ${subject}`.execute(db);
    await sql`DELETE FROM agent_run_log WHERE owner_subject = ${subject}`.execute(db);
    await sql`DELETE FROM llm_calls WHERE subject = ${subject}`.execute(db);
    await sql`DELETE FROM agent_memories WHERE agent_id IN (SELECT id FROM agents WHERE owner_subject = ${subject})`.execute(
      db
    );
    await sql`DELETE FROM agents WHERE owner_subject = ${subject}`.execute(db);
    await sql`DELETE FROM identities WHERE subject = ${subject}`.execute(db);
    await setOrgSettings({
      agentRunTimeoutMinutes: 30,
      agentRunToolCallBudget: 150,
      agentActStepsRequireApproval: 'externally_triggered',
    });
    await closeDatabase();
  });

  async function seedRun(
    options: {
      tools?: string[];
      autoAccept?: boolean;
      canAsk?: boolean;
      triggerKind?: 'manual' | 'event' | 'schedule' | 'api';
    } = {}
  ): Promise<{ runId: string; agentId: string }> {
    const definition: AgentDefinition = {
      instructions: '## Goal\n\nKeep PROJ tickets triaged.',
      tools: options.tools ?? [...READS, 'jira_add_comment'],
    };
    const agentId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        owner_subject: subject,
        name: `agent-${agentId.slice(0, 8)}`,
        instructions: definition.instructions,
        tools: JSON.stringify(definition.tools),
        auto_accept_actions: options.autoAccept === true,
        can_ask_questions: options.canAsk === true,
        enabled: true,
      })
      .execute();
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        agent_id: agentId,
        owner_subject: subject,
        trigger_kind: options.triggerKind ?? 'manual',
        definition_snapshot: JSON.stringify(definition),
        lineage: JSON.stringify([]),
        initial_state: JSON.stringify({ subject: 'PROJ-42 is broken' }),
        status: 'queued',
      })
      .execute();
    return { runId, agentId };
  }

  interface Harness {
    handler: ReturnType<typeof createAgentRunHandler>;
    executor: ReturnType<typeof createActionsHandler>;
    producer: CapturingProducer;
    calls: { name: string; args: Record<string, unknown> }[];
    minted: string[][];
    finalized: FinalizedRun[];
    clock: { now: number };
  }

  function harness(
    llm: ResolvedLlm,
    callTool: (
      name: string,
      args: Record<string, unknown>
    ) => McpToolResult | Promise<McpToolResult> = () => text('ok'),
    extra: { stopRequested?: () => boolean } = {}
  ): Harness {
    const producer = new CapturingProducer();
    const calls: Harness['calls'] = [];
    const minted: string[][] = [];
    const finalized: FinalizedRun[] = [];
    const clock = { now: Date.now() };
    const tokens = new Map<string, string[]>();
    const mintToken = async (params: { tools: string[] }) => {
      const token = `token-${minted.length}`;
      minted.push(params.tools);
      tokens.set(token, params.tools);
      return token;
    };
    const createMcpClient = (token: string) => stubMcp(tokens.get(token) ?? [], callTool, calls);
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      actionsProducer: producer,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the stub honors the slice the engine uses
      mintToken: mintToken as never,
      revokeToken: async () => undefined,
      createMcpClient,
      resolveLlm: async () => ok(llm),
      onFinalized: async (run) => {
        finalized.push(run);
      },
      now: () => clock.now,
      ...extra,
    });
    const executor = createActionsHandler({
      db,
      webBaseUrl: 'http://unused.example',
      runProducer: producer,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- as above
      mintToken: mintToken as never,
      revokeToken: async () => undefined,
      createMcpClient,
      now: () => clock.now,
    });
    return { handler, executor, producer, calls, minted, finalized, clock };
  }

  const runOf = (runId: string) =>
    db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error', 'active_ms', 'waiting_until'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
  const turnsOf = (runId: string) =>
    db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'attempt', 'status', 'tool_call_count', 'detail', 'outcome'])
      .where('run_id', '=', runId)
      .orderBy('attempt')
      .execute();

  it('reads, retries after a failed call, and finishes — every turn a sealed row', async () => {
    const { runId } = await seedRun();
    const llm = stubLlm((_request, n) =>
      n === 0
        ? call('jira_get_issue', { issueKey: 'PROJ-999' })
        : n === 1
          ? call('jira_search_issues', { jql: 'text ~ "broken"' })
          : finish('done', { result: 'PROJ-42' })
    );
    const h = harness(llm, (name) =>
      name === 'jira_get_issue' ? text('Issue PROJ-999 does not exist', true) : text('PROJ-42')
    );
    await h.handler({ payload: { runId } });

    expect((await runOf(runId)).status).toBe('succeeded');
    expect(h.calls.map((entry) => entry.name)).toEqual(['jira_get_issue', 'jira_search_issues']);
    const turns = await turnsOf(runId);
    expect(turns.map((turn) => [turn.step_id, turn.attempt, turn.status])).toEqual([
      [TURN_STEP_ID, 1, 'succeeded'],
      [TURN_STEP_ID, 2, 'succeeded'],
      [TURN_STEP_ID, 3, 'succeeded'],
    ]);
    expect(turns.map((turn) => turn.tool_call_count)).toEqual([1, 1, 0]);
    // Content is sealed; the clear half shows structure only.
    expect(JSON.stringify(turns[0].detail)).not.toContain('PROJ-999');
    expect(unsealed(turns[0].detail).opening).toContain('PROJ-42 is broken');
    // Each call names the tool_use it answers, so the run page can show the
    // whole stored result rather than the preview.
    const searchTurn = unsealed(turns[1].detail);
    const searchCall = Array.isArray(searchTurn.toolCalls) ? searchTurn.toolCalls[0] : null;
    const searchResult = Array.isArray(searchTurn.results) ? searchTurn.results[0] : null;
    expect(isRecord(searchCall) && typeof searchCall.toolUseId).toBe('string');
    expect(isRecord(searchResult) && isRecord(searchCall) && searchResult.toolUseId).toBe(
      isRecord(searchCall) ? searchCall.toolUseId : undefined
    );
    expect(h.finalized[0].vars).toEqual({ summary: 'declared done', result: 'PROJ-42' });

    // The opening fenced the trigger's words; the failed call's error and
    // the budget line reached the model.
    const opening = llm.requests[0].messages[0].content[0];
    expect(opening.type === 'text' && opening.text).toContain(
      '<untrusted source="trigger.subject">'
    );
    // The weekday is stated, not left for the model to work out.
    expect(opening.type === 'text' && opening.text).toMatch(/weekday: [A-Z][a-z]+day \(UTC\)/);
    const second = resultFor(llm.requests[1], lastToolUseId(llm.requests[1]));
    expect(second).toContain('does not exist');
    expect(second).toContain('[Budget left: 149 tool calls');
    expect(llm.requests[0].system).toContain('150 tool calls and 30 minutes of active time');
  });

  it('never lets the agent call an act tool: read-only token, direct calls refused', async () => {
    const { runId } = await seedRun();
    const llm = stubLlm((_request, n) =>
      n === 0 ? call('jira_add_comment', { issueKey: 'PROJ-42', body: 'hi' }) : finish('done')
    );
    const h = harness(llm);
    await h.handler({ payload: { runId } });

    // The probe token lists everything; the MODEL's token names reads only.
    expect(h.minted[1]).toEqual(['jira_get_issue', 'jira_search_issues']);
    const offered = llm.requests[0].tools?.map((tool) => tool.name) ?? [];
    expect(offered).toContain('stage_actions');
    expect(offered).not.toContain('jira_add_comment');
    const refused = resultFor(llm.requests[1], lastToolUseId(llm.requests[1]));
    expect(refused).toContain('propose it with stage_actions');
    expect(h.calls).toEqual([]);
  });

  it('stages a batch behind one card; on acceptance the executor runs it and the agent reads the outcome', async () => {
    const { runId } = await seedRun({ tools: [...READS, 'jira_add_comment', 'jira_create_issue'] });
    const llm = stubLlm((request, n) => {
      if (n === 0) {
        return call('stage_actions', {
          summary: 'File the ticket and say so',
          actions: [
            {
              tool: 'jira_create_issue',
              args: { summary: 'Login broken' },
              reason: 'No ticket yet',
            },
            {
              tool: 'jira_add_comment',
              args: { issueKey: 'PROJ-1', body: 'Filed' },
              reason: 'Tell them',
            },
          ],
        });
      }
      const report = resultFor(request, lastToolUseId(request));
      expect(report).toContain('accepted by the owner');
      // A staged call's result reaches the agent whole, like a direct read's:
      // cut at 4 000 it once ended a segment page at its fifth field.
      expect(report).toContain('Last field: AIG.14');
      return finish('done');
    });
    const longReply = `${'AIG.n field row. '.repeat(500)}Last field: AIG.14`;
    const h = harness(llm, (name) =>
      text(name === 'jira_create_issue' ? 'Created PROJ-43' : longReply)
    );

    h.clock.now += 1_000;
    await h.handler({ payload: { runId } });
    let run = await runOf(runId);
    expect(run.status).toBe('waiting');
    const card = await db
      .selectFrom('actionable_items')
      .select(['id', 'kind', 'suggested_action', 'step_id', 'attempt'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(card.kind).toBe('approval');
    expect(card.step_id).toBe(TURN_STEP_ID);
    const proposal = isRecord(card.suggested_action) ? card.suggested_action : {};
    const proposed = Array.isArray(proposal.actions) ? proposal.actions : [];
    expect(proposed.map((action) => (isRecord(action) ? action.tool : null))).toEqual([
      'jira_create_issue',
      'jira_add_comment',
    ]);
    // Both actions are billed once, on the staging turn.
    expect((await turnsOf(runId))[0].tool_call_count).toBe(2);
    expect(h.calls).toEqual([]);

    // A long wait for the owner — none of it counts.
    const activeBefore = Number(run.active_ms);
    h.clock.now += 6 * 3_600_000;
    await db
      .updateTable('actionable_items')
      .set({ status: 'approved', decided_at: sql`NOW()`, decided_by: subject })
      .where('id', '=', card.id)
      .execute();
    await h.handler({ payload: { runId } });
    run = await runOf(runId);
    expect(run.status).toBe('waiting'); // now on the executor
    const batchJobs = h.producer.take('actions');
    expect(batchJobs).toHaveLength(1);
    expect(h.calls).toEqual([]); // the engine itself made no call

    await h.executor({ payload: batchJobs[0].payload });
    expect(h.calls.map((entry) => entry.name)).toEqual(['jira_create_issue', 'jira_add_comment']);
    const batch = await db
      .selectFrom('agent_action_batches')
      .select(['status', 'accepted_by', 'results'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(batch.status).toBe('completed');
    expect(batch.accepted_by).toBe('person');
    expect(h.producer.take('run')).toHaveLength(1);

    await h.handler({ payload: { runId } });
    run = await runOf(runId);
    expect(run.status).toBe('succeeded');
    expect(Number(run.active_ms)).toBeLessThan(activeBefore + 60_000);
  });

  it('auto-accepts where the org allows it, but a high-risk tool still waits for a person', async () => {
    const { runId } = await seedRun({ autoAccept: true });
    const llm = stubLlm((_request, n) =>
      n === 0
        ? call('stage_actions', {
            summary: 'Comment',
            actions: [{ tool: 'jira_add_comment', args: { body: 'x' }, reason: 'r' }],
          })
        : finish('done')
    );
    const h = harness(llm);
    await h.handler({ payload: { runId } });
    expect(
      await db.selectFrom('actionable_items').select('id').where('run_id', '=', runId).execute()
    ).toEqual([]);
    const jobs = h.producer.take('actions');
    expect(jobs).toHaveLength(1);
    await h.executor({ payload: jobs[0].payload });
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('succeeded');
    const report = resultFor(llm.requests[1], lastToolUseId(llm.requests[1]));
    expect(report).toContain('accepted automatically');

    const risky = await seedRun({ autoAccept: true, tools: [...READS, 'outlook_send_mail'] });
    const riskyLlm = stubLlm(() =>
      call('stage_actions', {
        summary: 'Mail',
        actions: [{ tool: 'outlook_send_mail', args: {}, reason: 'r' }],
      })
    );
    await harness(riskyLlm).handler({ payload: { runId: risky.runId } });
    const batch = await db
      .selectFrom('agent_action_batches')
      .select(['status', 'review_reason'])
      .where('run_id', '=', risky.runId)
      .executeTakeFirstOrThrow();
    expect(batch).toEqual({ status: 'proposed', review_reason: 'high-risk' });

    // An event-started run ignores auto-accept under the default policy.
    const external = await seedRun({ autoAccept: true, triggerKind: 'event' });
    const externalLlm = stubLlm(() =>
      call('stage_actions', {
        summary: 'Comment',
        actions: [{ tool: 'jira_add_comment', args: {}, reason: 'r' }],
      })
    );
    await harness(externalLlm).handler({ payload: { runId: external.runId } });
    expect(
      (
        await db
          .selectFrom('agent_action_batches')
          .select('review_reason')
          .where('run_id', '=', external.runId)
          .executeTakeFirstOrThrow()
      ).review_reason
    ).toBe('policy');
  });

  it('reports a declined batch, and a batch that stopped at its first failure', async () => {
    const { runId } = await seedRun({ tools: [...READS, 'jira_add_comment', 'jira_create_issue'] });
    const llm = stubLlm((request, n) =>
      n === 0
        ? call('stage_actions', {
            summary: 'Two things',
            actions: [
              { tool: 'jira_create_issue', args: {}, reason: 'a' },
              { tool: 'jira_add_comment', args: {}, reason: 'b' },
            ],
          })
        : n === 1
          ? (expect(resultFor(request, lastToolUseId(request))).toContain('declined'),
            call('stage_actions', {
              summary: 'Try again',
              actions: [
                { tool: 'jira_create_issue', args: {}, reason: 'a' },
                { tool: 'jira_add_comment', args: {}, reason: 'b' },
              ],
            }))
          : finish('failed')
    );
    const h = harness(llm, (name) =>
      name === 'jira_create_issue' ? text('Project not found', true) : text('ok')
    );
    await h.handler({ payload: { runId } });
    await db
      .updateTable('actionable_items')
      .set({
        status: 'declined',
        decided_at: sql`NOW()`,
        result: JSON.stringify({ comment: 'Not now' }),
      })
      .where('run_id', '=', runId)
      .execute();
    await h.handler({ payload: { runId } });
    // Staged again on turn 2; accept it this time.
    await db
      .updateTable('actionable_items')
      .set({ status: 'approved', decided_at: sql`NOW()` })
      .where('run_id', '=', runId)
      .where('status', '=', 'suggested')
      .execute();
    await h.handler({ payload: { runId } });
    await h.executor({ payload: h.producer.take('actions')[0].payload });
    expect(h.calls.map((entry) => entry.name)).toEqual(['jira_create_issue']);
    await h.handler({ payload: { runId } });
    const report = resultFor(llm.requests[2], lastToolUseId(llm.requests[2]));
    expect(report).toContain('1. jira_create_issue: failed. Project not found');
    expect(report).toContain('2. jira_add_comment: skipped.');
    expect((await runOf(runId)).status).toBe('failed');
  });

  it('stops a batch mid-way when the run is canceled, never making the rest', async () => {
    const { runId } = await seedRun({
      autoAccept: true,
      tools: [...READS, 'jira_add_comment', 'jira_create_issue'],
    });
    const llm = stubLlm(() =>
      call('stage_actions', {
        summary: 'Two changes',
        actions: [
          { tool: 'jira_create_issue', args: {}, reason: 'a' },
          { tool: 'jira_add_comment', args: {}, reason: 'b' },
        ],
      })
    );
    const h = harness(llm, async (name) => {
      // The owner presses Cancel while the first change is going out.
      if (name === 'jira_create_issue') {
        await db
          .updateTable('agent_runs')
          .set({ cancel_requested_at: sql`NOW()` })
          .where('id', '=', runId)
          .execute();
      }
      return text('ok');
    });
    await h.handler({ payload: { runId } });
    await h.executor({ payload: h.producer.take('actions')[0].payload });
    expect(h.calls.map((entry) => entry.name)).toEqual(['jira_create_issue']);
    const batch = await db
      .selectFrom('agent_action_batches')
      .select(['status', 'results'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(batch.status).toBe('completed');
    expect(JSON.stringify(batch.results)).toContain('Not made: the run was canceled.');
    // The woken run ends canceled, quietly.
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('canceled');
  });

  it('holds the tool budget: refuses calls past it, then forces finish_run', async () => {
    await setOrgSettings({ agentRunToolCallBudget: 2 });
    try {
      const { runId } = await seedRun();
      const llm = stubLlm((request, n) => {
        if (request.toolChoice && typeof request.toolChoice === 'object') return finish('failed');
        return call('jira_search_issues', { page: n });
      });
      const h = harness(llm);
      await h.handler({ payload: { runId } });
      expect(h.calls).toHaveLength(2);
      const forced = llm.requests[llm.requests.length - 1];
      expect(forced.toolChoice).toEqual({ name: 'finish_run' });
      expect((await runOf(runId)).status).toBe('failed');
    } finally {
      await setOrgSettings({ agentRunToolCallBudget: 150 });
    }
  });

  it('hands read work to a sub-agent: its calls are billed to the parent, only its report returns', async () => {
    const { runId } = await seedRun();
    const isSub = (request: LlmRequest) => request.system.startsWith('You are a sub-agent');
    const llm = stubLlm((request, n) => {
      if (isSub(request)) {
        const tools = request.tools?.map((tool) => tool.name) ?? [];
        // A sub-agent can read, use the free clock, and nothing else.
        expect(tools).toEqual(['resolve_time', 'jira_search_issues']);
        expect(request.system).toMatch(/Facts:\n[\s\S]*- today: \d{4}-\d{2}-\d{2}/);
        return request.messages.length === 1
          ? call('jira_search_issues', { jql: 'project = PROJ' })
          : {
              content: [{ type: 'text', text: 'PROJ-42 is broken: "blocked on vendor"' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 5 },
            };
      }
      return n === 0
        ? call('spawn_agent', { task: 'Find what blocks PROJ-42', tools: ['jira_search_issues'] })
        : finish('done');
    });
    const h = harness(llm);
    await h.handler({ payload: { runId } });

    expect((await runOf(runId)).status).toBe('succeeded');
    expect(h.calls.map((entry) => entry.name)).toEqual(['jira_search_issues']);
    expect(llm.requests[0].tools?.map((tool) => tool.name)).toContain('spawn_agent');
    const parentBack = llm.requests.filter((request) => !isSub(request))[1];
    const report = resultFor(parentBack, lastToolUseId(parentBack));
    expect(report).toContain('blocked on vendor');
    expect(report).toContain('counted against your budget');
    // The sub-agent's read is billed to the parent's turn, so the budget sees it.
    const turns = await turnsOf(runId);
    expect(turns[0].tool_call_count).toBe(1);
  });

  it('runs sub-agents in parallel, three at a time, and no more than ten in a run', async () => {
    const { runId } = await seedRun();
    const isSub = (request: LlmRequest) => request.system.startsWith('You are a sub-agent');
    const spawnAll = (count: number): LlmResponse => ({
      content: Array.from({ length: count }, (_, i) => ({
        type: 'tool_use' as const,
        id: `sp_${(toolUseSeq += 1)}`,
        name: 'spawn_agent',
        input: { task: `job ${i}` },
      })),
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    let parentTurns = 0;
    const llm = stubLlm((request) => {
      if (isSub(request)) {
        return request.messages.length === 1
          ? call('jira_search_issues', {})
          : {
              content: [{ type: 'text', text: 'report' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
      }
      parentTurns += 1;
      return parentTurns === 1 ? spawnAll(8) : parentTurns === 2 ? spawnAll(4) : finish('done');
    });
    let running = 0;
    let peak = 0;
    const h = harness(llm, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 30));
      running -= 1;
      return text('ok');
    });
    await h.handler({ payload: { runId } });

    expect((await runOf(runId)).status).toBe('succeeded');
    expect(peak).toBe(3);
    // 8 + 4 asked for; the tenth is the last one started, the other two are refused.
    expect(h.calls).toHaveLength(10);
    const parentRequests = llm.requests.filter((request) => !isSub(request));
    const lastBlocks = parentRequests[2].messages[parentRequests[2].messages.length - 1].content;
    const refused = lastBlocks.filter(
      (block) => block.type === 'tool_result' && block.content.includes('At most 10 sub-agents')
    );
    expect(refused).toHaveLength(2);
  });

  it('stops a sub-agent at the run’s budget and takes its report, with the budget deducted at use', async () => {
    await setOrgSettings({ agentRunToolCallBudget: 2 });
    try {
      const { runId } = await seedRun();
      const isSub = (request: LlmRequest) => request.system.startsWith('You are a sub-agent');
      let subTurns = 0;
      const llm = stubLlm((request, n) => {
        if (isSub(request)) {
          subTurns += 1;
          // Keeps asking for reads; once told to stop, the call has no tools.
          if (request.tools?.length === 0) {
            return {
              content: [{ type: 'text', text: 'Got two; the third was not made.' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
          return call('jira_search_issues', { page: subTurns });
        }
        if (request.toolChoice && typeof request.toolChoice === 'object') return finish('done');
        return n === 0 ? call('spawn_agent', { task: 'read three pages' }) : finish('done');
      });
      const h = harness(llm);
      await h.handler({ payload: { runId } });
      // Two reads fit the budget; the third was refused and the sub-agent reported.
      expect(h.calls).toHaveLength(2);
      const parentBack = llm.requests.filter((request) => !isSub(request))[1];
      const report = resultFor(parentBack, lastToolUseId(parentBack));
      expect(report).toContain('Sub-agent made 2 tool calls');
      expect(report).toContain('third was not made');
      const subRequests = llm.requests.filter(isSub);
      const stopNote = subRequests[subRequests.length - 1].messages.at(-1)?.content.at(-1);
      expect(stopNote?.type === 'text' && stopNote.text).toContain("the run's tool budget is spent");
      expect((await runOf(runId)).status).toBe('succeeded');
    } finally {
      await setOrgSettings({ agentRunToolCallBudget: 150 });
    }
  });

  it('ends a run that uses up its active time', async () => {
    await setOrgSettings({ agentRunTimeoutMinutes: 1 });
    try {
      const { runId } = await seedRun();
      // Each tool call takes 25 seconds of the agent's time.
      const slow = harness(
        stubLlm(() => call('jira_search_issues')),
        () => {
          slow.clock.now += 25_000;
          return text('more');
        }
      );
      await slow.handler({ payload: { runId } });
      const run = await runOf(runId);
      expect(run.status).toBe('failed');
      expect(run.error_kind).toBe('timeout');
      expect(slow.calls.length).toBeLessThanOrEqual(3);
    } finally {
      await setOrgSettings({ agentRunTimeoutMinutes: 30 });
    }
  });

  it('never repeats a call that was in flight when the executor died', async () => {
    const { runId } = await seedRun();
    // The row exactly as a dead executor leaves it: the model asked for a
    // call, and the call was marked in flight before it went out.
    const detail = {
      opening: 'Started by hand.',
      assistant: [{ type: 'tool_use', id: 'tu_crashed', name: 'jira_search_issues', input: {} }],
      results: [],
      inFlight: 'tu_crashed',
    };
    await db
      .insertInto('agent_run_steps')
      .values({
        id: randomUUID(),
        run_id: runId,
        step_id: TURN_STEP_ID,
        step_index: 1,
        attempt: 1,
        iteration: 0,
        status: 'running',
        tool_call_count: 1,
        detail: JSON.stringify({ sealed: fakeSeal(JSON.stringify(detail)) }),
      })
      .execute();
    await db
      .updateTable('agent_runs')
      .set({ status: 'running', started_at: sql`NOW()` })
      .where('id', '=', runId)
      .execute();

    const llm = stubLlm(() => finish('done'));
    const h = harness(llm);
    await h.handler({ payload: { runId } });
    expect(h.calls).toEqual([]);
    expect(resultFor(llm.requests[0], 'tu_crashed')).toContain('outcome is unknown');
    expect((await runOf(runId)).status).toBe('succeeded');
  });

  it('hands a run back when the executor is stopping, and the next one continues it', async () => {
    const { runId } = await seedRun();
    let stop = false;
    const llm = stubLlm((_request, n) => (n === 0 ? call('jira_search_issues') : finish('done')));
    const h = harness(
      llm,
      () => {
        stop = true; // SIGTERM lands while the call is out
        return text('found');
      },
      { stopRequested: () => stop }
    );
    await expect(h.handler({ payload: { runId } })).rejects.toBeInstanceOf(MessageReleased);
    expect((await runOf(runId)).status).toBe('running');
    stop = false;
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('succeeded');
    // The call that finished before the stop was not repeated.
    expect(h.calls).toHaveLength(1);
  });

  it('asks a person and carries on with the answer', async () => {
    const { runId } = await seedRun({ canAsk: true });
    const llm = stubLlm((request, n) => {
      if (n === 0) {
        return call('ask_person', {
          message: 'Which project?',
          form: [
            { kind: 'field', name: 'project', label: 'Project', type: 'text', required: true },
          ],
        });
      }
      expect(resultFor(request, lastToolUseId(request))).toContain('Q: Project\nA: OPS');
      return finish('done');
    });
    const h = harness(llm);
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('waiting');
    await db
      .updateTable('actionable_items')
      .set({
        status: 'answered',
        decided_at: sql`NOW()`,
        result: JSON.stringify({ answers: { project: 'OPS' } }),
      })
      .where('run_id', '=', runId)
      .execute();
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('succeeded');
  });

  it('asks a batch of questions, each answered or skipped on its own', async () => {
    const { runId } = await seedRun({ canAsk: true });
    const llm = stubLlm((request, n) => {
      if (n === 0) {
        return call('ask_person', {
          intro: 'ATLAS went live on Azure 10/17–10/19; two things need a home.',
          questions: [
            {
              question: 'Should the ATLAS go-live status go on CIO-5, CIO-25 or CIO-26?',
              context: '837 lab orders on 10/19; DigiPort testing still open.',
              answer: { type: 'choice', options: ['CIO-5', 'CIO-25', 'CIO-26', 'Something else'] },
            },
            { question: 'Does the xCures SFTP work need a CIO-39 update?', answer: { type: 'yesno' } },
          ],
        });
      }
      const result = resultFor(request, lastToolUseId(request)) ?? '';
      expect(result).toContain(
        'Q: Should the ATLAS go-live status go on CIO-5, CIO-25 or CIO-26?\nA: CIO-25'
      );
      expect(result).toContain(
        'Q: Does the xCures SFTP work need a CIO-39 update?\nA: (skipped — no answer given)'
      );
      expect(result).toContain('Also: Kelvin owns the SFTP piece.');
      return finish('done');
    });
    const h = harness(llm);
    await h.handler({ payload: { runId } });
    const card = await db
      .selectFrom('actionable_items')
      .select(['suggested_action', 'summary'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(card.summary).toBe('ATLAS went live on Azure 10/17–10/19; two things need a home.');
    const fields = JSON.stringify(card.suggested_action);
    expect(fields).toContain('"name":"q1"');
    expect(fields).toContain('"options":["Yes","No"]');
    expect(fields).toContain('"name":"anything_else"');
    await db
      .updateTable('actionable_items')
      .set({
        status: 'answered',
        decided_at: sql`NOW()`,
        result: JSON.stringify({
          answers: { q1: 'CIO-25', anything_else: 'Kelvin owns the SFTP piece.' },
        }),
      })
      .where('run_id', '=', runId)
      .execute();
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('succeeded');
  });

  it('folds older turns into a summary when the conversation outgrows the model', async () => {
    const { runId } = await seedRun();
    const read = `${'r'.repeat(12_000)}`;
    const llm = stubLlm((request) => {
      if (request.system === RUN_COMPACTION_SYSTEM) {
        return {
          content: [{ type: 'text', text: 'NOTES: read PROJ-1 to PROJ-4; next, finish.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      const main = llm.requests.filter((sent) => sent.system !== RUN_COMPACTION_SYSTEM).length;
      return main <= 7 ? call('jira_get_issue', { issueKey: `PROJ-${main}` }) : finish('done');
    });
    // A small window: the conversation budget is the 40 000-character floor.
    llm.contextWindow = 20_000;
    const h = harness(llm, () => text(read));
    await h.handler({ payload: { runId } });

    expect((await runOf(runId)).status).toBe('succeeded');
    const folds = llm.requests.filter((sent) => sent.system === RUN_COMPACTION_SYSTEM);
    expect(folds.length).toBeGreaterThanOrEqual(1);
    const mains = llm.requests.filter((sent) => sent.system !== RUN_COMPACTION_SYSTEM);
    // Every request the run sent fitted the model's budget.
    for (const sent of mains) expect(messagesChars(sent.messages)).toBeLessThanOrEqual(40_000);
    // After the fold: the opening, then the notes, and not the folded turns.
    const last = mains[mains.length - 1];
    const first = JSON.stringify(last.messages[0].content);
    expect(first).toContain('Your notes on turns 1–');
    expect(first).toContain('NOTES: read PROJ-1 to PROJ-4');
    expect(JSON.stringify(last.messages)).not.toContain('"issueKey":"PROJ-1"');
    // The fold is kept on its turn, sealed with the rest of the run's content.
    const turns = await turnsOf(runId);
    const withFold = turns.map((turn) => unsealed(turn.detail).compaction).filter(Boolean);
    expect(withFold[0]).toMatchObject({ summary: 'NOTES: read PROJ-1 to PROJ-4; next, finish.' });
    expect(JSON.stringify(turns.map((turn) => turn.detail))).not.toContain('NOTES:');
  });

  it('resumes a failed run with the owner’s guidance and a fresh budget', async () => {
    const { runId, agentId } = await seedRun();
    const failing = stubLlm(() => finish('failed'));
    const h = harness(failing);
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('failed');

    const resumed = await resumeAgentRun(h.producer, {
      agentId,
      runId,
      ownerSubject: subject,
      resumedBySubject: subject,
      guidance: 'Look in project OPS instead',
    });
    expect(resumed.ok).toBe(true);
    const llm = stubLlm(() => finish('done'));
    await harness(llm).handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('succeeded');
    const lastUser = llm.requests[0].messages[llm.requests[0].messages.length - 1];
    expect(JSON.stringify(lastUser.content)).toContain('Look in project OPS instead');
  });

  it('ends quietly when there is nothing to do, and a terminal run redelivered is a no-op', async () => {
    const { runId } = await seedRun();
    const llm = stubLlm(() => finish('nothing_to_do', { quiet: true }));
    const h = harness(llm);
    await h.handler({ payload: { runId } });
    expect((await runOf(runId)).status).toBe('stopped');
    expect(h.finalized[0].quiet).toBe(true);
    await h.handler({ payload: { runId } });
    expect(llm.requests).toHaveLength(1);
  });

  it('parks a run whose owner has no key delegation', async () => {
    const { runId } = await seedRun();
    ownerDelegated = false;
    try {
      await harness(stubLlm(() => finish('done'))).handler({ payload: { runId } });
    } finally {
      ownerDelegated = true;
    }
    const run = await runOf(runId);
    expect(run.status).toBe('waiting');
    expect(run.error_kind).toBe('needs-sign-in');
  });
});

