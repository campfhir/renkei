/**
 * The engine against a real database (skipped without DATABASE_URL) and a
 * scripted model/MCP pair. What must hold: a run executes its snapshot and
 * records every attempt; a declared success stands; a retry path consumes
 * the step's TOTAL attempt budget and never exceeds the platform's 5; a
 * failure with an 'exit' handling stops the run; redelivering a terminal
 * run is a no-op.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { ok } from '@campfhir/safe-functions/helpers';
import type { LlmRequest, LlmResponse, ResolvedLlm } from '@renkei/agent-llm';
import {
  isAgentStepsDoc,
  type AgentStepNode,
  type AgentStepsDoc,
  type ApprovalStep,
  type InstructionSegment,
  type TerminalStep,
} from '@renkei/agents';
import { createAgentRunHandler } from './engine';
import { createApprovalSweep } from './approval-sweep';
import type { QueueMessageInput } from '@renkei/queue';
import type { McpClient, McpToolResult } from './mcp-client';
import { recordedLogs, renderLog, resetRecordedLogs } from './test-support/logger-mock';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

/** Mirrors CONDITION_TURNS in engine.ts — the decision turn cap. */
const CONDITION_TURNS_IN_TEST = 4;

type Scripted = (request: LlmRequest, call: number) => LlmResponse;

function stubLlm(script: Scripted): ResolvedLlm {
  let calls = 0;
  return {
    provider: {
      complete: async (request) => {
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

function stubMcp(tools: string[], callTool: (name: string) => McpToolResult): McpClient {
  return {
    initialize: async () => undefined,
    listTools: async () =>
      tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })),
    callTool: async (name) => callTool(name),
  };
}

const finish = (
  outcome: 'success' | 'failure' | 'skipped' | 'nothing-to-do',
  extra: Record<string, unknown> = {}
): LlmResponse => ({
  content: [
    {
      type: 'tool_use',
      id: `tu_${Math.random().toString(36).slice(2)}`,
      name: 'finish_step',
      input: { outcome, summary: `declared ${outcome}`, ...extra },
    },
  ],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
});

const useTool = (name: string, input: Record<string, unknown> = {}): LlmResponse => ({
  content: [{ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name, input }],
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
});

const okToolResult: McpToolResult = {
  content: [{ type: 'text', text: 'PROJ-42: The printer is on fire' }],
  isError: false,
  meta: {},
};

const notFoundToolResult: McpToolResult = {
  content: [{ type: 'text', text: 'Issue PROJ-999 does not exist' }],
  isError: true,
  meta: {},
};

maybe('agent run engine', () => {
  jest.setTimeout(20_000);

  // Acquired in beforeAll, not at describe-collection time: describe.skip still
  // runs its callback to register tests, so acquiring the database here (when
  // this suite is skipped for lack of DATABASE_URL) would throw at collection
  // and fail the whole file instead of skipping it.
  let db: Kysely<DB>;

  const tenantId = randomUUID();
  const subject = `test-subject-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `engine-test-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('identities')
      .values({
        tenant_id: tenantId,
        subject,
        email: 'owner@example.com',
        display_name: 'Test Owner',
      })
      .execute();
  });

  afterAll(async () => {
    // Cascades take agents/runs/steps/triggers/tokens with the tenant.
    await db.deleteFrom('oauth_access_tokens').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('oauth_clients').where('tenant_id', '=', tenantId).execute();
    await sql`DELETE FROM actionable_items WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_run_steps WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_triggers WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM identities WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  async function seedRun(steps: AgentStepsDoc): Promise<{ runId: string; agentId: string }> {
    const agentId = randomUUID();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: subject,
        name: `agent-${agentId.slice(0, 8)}`,
        steps: JSON.stringify(steps),
        enabled: true,
      })
      .execute();
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: subject,
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify(steps),
        lineage: JSON.stringify([]),
        initial_state: JSON.stringify({ subject: 'PROJ-42 is broken' }),
        status: 'queued',
      })
      .execute();
    return { runId, agentId };
  }

  function handlerWith(llm: ResolvedLlm, mcp: McpClient, onFinalized?: never) {
    return createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () => mcp,
      resolveLlm: async () => ok(llm),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
      onFinalized,
    });
  }

  const singleStep = (overrides: Record<string, unknown> = {}): AgentStepsDoc => ({
    version: 1,
    steps: [
      {
        id: randomUUID(),
        name: 'Find the ticket',
        instruction: [
          { t: 'text', v: 'Find the ticket mentioned in ' },
          { t: 'var', name: 'trigger.subject' },
          { t: 'text', v: ' using ' },
          { t: 'tool', name: 'jira_get_issue' },
        ],
        tool: 'jira_get_issue',
        maxAttempts: 3,
        saveAs: 'theTicket',
        failureHandling: [
          {
            outcome: 'not-found',
            action: 'retry',
            guidance: [{ t: 'text', v: 'Search by summary text instead.' }],
          },
        ],
        ...overrides,
      },
    ],
  });

  it('runs a single step to success and records the attempt', async () => {
    const { runId } = await seedRun(singleStep());
    const llm = stubLlm((_request, call) =>
      call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-42' })
        : finish('success', { saveValue: 'PROJ-42' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    expect(run.error_kind).toBeNull();

    const attempts = await db
      .selectFrom('agent_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect(attempts[0].outcome).toBe('tool_ok');
    expect(attempts[0].tool_call_count).toBe(1);
    const detail: { saveValue?: unknown; resolvedInstruction?: unknown } =
      typeof attempts[0].detail === 'object' &&
      attempts[0].detail !== null &&
      !Array.isArray(attempts[0].detail)
        ? attempts[0].detail
        : {};
    expect(detail.saveValue).toBe('PROJ-42');
    // Chips rendered: the var chip became the trigger value, the tool chip
    // its canonical name.
    expect(detail.resolvedInstruction).toContain('PROJ-42 is broken');
    expect(detail.resolvedInstruction).toContain('jira_get_issue');
  });

  it('feeds a _meta document attachment to the model as a typed block', async () => {
    const { runId } = await seedRun(singleStep());
    const seen: LlmRequest[] = [];
    const llm = stubLlm((request, call) => {
      seen.push(request);
      return call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-42' })
        : finish('success', { saveValue: 'PROJ-42' });
    });
    const withDocument: McpToolResult = {
      content: [{ type: 'text', text: 'report.pdf (application/pdf, 3 B), extracted text: …' }],
      isError: false,
      meta: {
        renkeiDocuments: [
          { mediaType: 'application/pdf', dataBase64: 'QUJD', title: 'report.pdf' },
        ],
      },
    };
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => withDocument)
    );
    await handler({ payload: { runId } });

    // The follow-up model call carries the tool result — and after it, the
    // document as a typed block the provider decodes into pages, never as
    // base64 inside the text the model reads. (The engine mutates one
    // messages array across turns, so locate the message by its content.)
    const followUp = seen[1];
    expect(followUp).toBeDefined();
    const carrier = followUp.messages.find((message) =>
      message.content.some((block) => block.type === 'document')
    );
    expect(carrier).toBeDefined();
    expect(carrier?.role).toBe('user');
    expect(carrier?.content[0]?.type).toBe('tool_result');
    const documentBlock = carrier?.content.find((block) => block.type === 'document');
    expect(documentBlock).toMatchObject({
      mediaType: 'application/pdf',
      dataBase64: 'QUJD',
      title: 'report.pdf',
    });
  });

  it('retries per failure handling and exhausts the TOTAL attempt budget', async () => {
    const { runId } = await seedRun(singleStep({ maxAttempts: 2 }));
    const llm = stubLlm((_request, call) =>
      call % 2 === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-999' })
        : finish('failure', { code: 'not-found' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => notFoundToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('step_failed');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['attempt', 'status', 'outcome_code'])
      .where('run_id', '=', runId)
      .orderBy('attempt')
      .execute();
    // Total attempts, not retries-after-first: maxAttempts 2 → exactly 2 rows.
    expect(attempts.map((row) => row.attempt)).toEqual([1, 2]);
    expect(attempts.every((row) => row.status === 'failed')).toBe(true);
    expect(attempts[0].outcome_code).toBe('not-found');
  });

  it('caps the budget at the platform ceiling even if the snapshot lies', async () => {
    // A snapshot claiming 99 attempts (as if the validator were bypassed).
    const { runId } = await seedRun(singleStep({ maxAttempts: 99 }));
    const llm = stubLlm((_request, call) =>
      call % 2 === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-999' })
        : finish('failure', { code: 'not-found' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => notFoundToolResult)
    );
    await handler({ payload: { runId } });

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('attempt')
      .where('run_id', '=', runId)
      .execute();
    // The org's agentMaxStepAttempts (default 10) is the binding ceiling —
    // the snapshot's 99 is a lie past it, however it got stored.
    expect(attempts).toHaveLength(10);
  });

  it('forces a finish_step verdict when the tool budget runs out, and a declared success stands', async () => {
    const { runId } = await seedRun(singleStep());
    const requests: LlmRequest[] = [];
    // Three searches spend the budget; the fourth is refused; then declare.
    const llm = stubLlm((request, call) => {
      requests.push(request);
      return call < 4
        ? useTool('jira_get_issue', { issueKey: `PROJ-${call}` })
        : finish('success', { saveValue: 'PROJ-42' });
    });
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    // The model was told its budget up front...
    const firstText = requests[0].messages[0]?.content.find((block) => block.type === 'text');
    expect(firstText && 'text' in firstText ? firstText.text : '').toContain(
      'Tool budget: at most 3'
    );
    // ...and after spending it, the conversation narrowed to finish_step only.
    const forced = requests[4];
    expect(forced.tools.map((tool) => tool.name)).toEqual(['finish_step']);
    expect(forced.toolChoice).toEqual({ name: 'finish_step' });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['status', 'outcome', 'tool_call_count'])
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    // Only the three in-budget calls ran; the refused fourth was never made.
    expect(attempts[0].tool_call_count).toBe(3);
  });

  it('routes a budget-exhausted declared failure through failure handling, not guard', async () => {
    const { runId } = await seedRun(
      singleStep({ failureHandling: [{ outcome: 'not-found', action: 'exit' }] })
    );
    const llm = stubLlm((_request, call) =>
      call < 4
        ? useTool('jira_get_issue', { issueKey: `PROJ-${call}` })
        : finish('failure', { code: 'not-found' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    // The routable outcome the owner configured — not an unroutable guard.
    expect(run.error_kind).toBe('step_failed');
    expect(run.error).toContain('not-found');
    expect(run.error).not.toContain('tool-call limit');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['outcome', 'outcome_code', 'tool_call_count'])
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('llm_declared');
    expect(attempts[0].outcome_code).toBe('not-found');
    expect(attempts[0].tool_call_count).toBe(3);
  });

  it("ends the run as stopped when the failure's handling declares it not an error", async () => {
    // "Ticket not found" is not always a failure: the owner marked the code
    // 'stop-quiet', so the run ends as the graceful 'stopped' terminal —
    // silent, nothing red — while the attempt row keeps the real outcome.
    const { runId } = await seedRun(
      singleStep({ failureHandling: [{ outcome: 'not-found', action: 'stop-quiet' }] })
    );
    const finalized: unknown[] = [];
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () => stubMcp(['jira_get_issue'], () => notFoundToolResult),
      resolveLlm: async () => ok(stubLlm(() => finish('failure', { code: 'not-found' }))),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
      onFinalized: async (run) => {
        finalized.push(run);
      },
    });
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('stopped');
    expect(run.error_kind).toBeNull();
    expect(run.error).toBeNull();

    // The attempt keeps its outcome code (the timeline says what happened)
    // but its status matches the run's graceful end — not a red Failed pill
    // inside a skipped run, and not admin-visible content either
    // (the redaction rule shows step content only for failures).
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['status', 'outcome_code'])
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('stopped');
    expect(attempts[0].outcome_code).toBe('not-found');

    // Quiet: no notification, no chained agents.
    expect(finalized[0]).toMatchObject({ status: 'stopped', quiet: true });
  });

  it("continues to the next step when the failure's handling says continue", async () => {
    const secondStepId = randomUUID();
    const steps: AgentStepsDoc = {
      version: 7,
      steps: [
        {
          id: randomUUID(),
          name: 'Find the ticket',
          instruction: [
            { t: 'text', v: 'Find the ticket using ' },
            { t: 'tool', name: 'jira_get_issue' },
          ],
          tool: 'jira_get_issue',
          maxAttempts: 1,
          saveAs: 'theTicket',
          failureHandling: [{ outcome: 'not-found', action: 'continue' }],
        },
        {
          id: secondStepId,
          name: 'Decide what to do',
          instruction: [
            { t: 'text', v: 'Decide from ' },
            { t: 'var', name: 'theTicket' },
          ],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    };
    const { runId } = await seedRun(steps);
    const seen: string[] = [];
    const llm = stubLlm((request, call) => {
      seen.push(JSON.stringify(request.messages));
      return call === 0 ? finish('failure', { code: 'not-found' }) : finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => notFoundToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    // The failure stayed on the step; the run moved on and finished.
    expect(run.status).toBe('succeeded');
    expect(run.error_kind).toBeNull();

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'status', 'outcome_code'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe('failed');
    expect(attempts[0].outcome_code).toBe('not-found');
    expect(attempts[1].status).toBe('succeeded');
    // The saved result bound to the failure summary, so the second step's
    // prompt saw what happened instead of an unbound chip.
    expect(seen[1]).toContain('theTicket: declared failure');
  });

  it('takes the exhausted choice when every retry fails', async () => {
    const steps: AgentStepsDoc = {
      version: 7,
      steps: [
        {
          id: randomUUID(),
          name: 'Search for a ticket',
          instruction: [
            { t: 'text', v: 'Search using ' },
            { t: 'tool', name: 'jira_get_issue' },
          ],
          tool: 'jira_get_issue',
          maxAttempts: 2,
          saveAs: 'theTicket',
          failureHandling: [
            {
              outcome: 'not-found',
              action: 'retry',
              guidance: [{ t: 'text', v: 'Search by summary text instead.' }],
              exhausted: 'continue',
            },
          ],
        },
        {
          id: randomUUID(),
          name: 'Carry on regardless',
          instruction: [{ t: 'text', v: 'Proceed.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    };
    const { runId } = await seedRun(steps);
    const llm = stubLlm((_request, call) =>
      call < 2 ? finish('failure', { code: 'not-found' }) : finish('success')
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => notFoundToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    // Both tries failed; the exhausted choice moved the run on instead of
    // failing it — the pre-v7 default only binds when nothing was chosen.
    expect(run.status).toBe('succeeded');
    expect(run.error_kind).toBeNull();

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['status'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .orderBy('attempt')
      .execute();
    expect(attempts.map((row) => row.status)).toEqual(['failed', 'failed', 'succeeded']);
  });

  it("accepts the legacy 'nothing-to-do' spelling as a skip", async () => {
    const { runId } = await seedRun(singleStep({ failureHandling: [], maxAttempts: 1 }));
    const handler = handlerWith(
      stubLlm(() => finish('nothing-to-do')),
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('stopped');
    expect(run.error_kind).toBeNull();
  });

  it('a run flagged for cancellation before it starts finalizes as canceled, untouched', async () => {
    const { runId } = await seedRun(singleStep());
    await db
      .updateTable('agent_runs')
      .set({ cancel_requested_at: sql`NOW()` })
      .where('id', '=', runId)
      .execute();
    let llmCalls = 0;
    const handler = handlerWith(
      stubLlm(() => {
        llmCalls += 1;
        return finish('success');
      }),
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('canceled');
    expect(run.error).toBe('Canceled by request.');
    expect(llmCalls).toBe(0);

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('step_id')
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(0);
  });

  it('a run canceled mid-execution stops at the next step boundary, never reaching the one after', async () => {
    const twoSteps: AgentStepsDoc = {
      version: 1,
      steps: [
        {
          id: randomUUID(),
          name: 'First step',
          instruction: [{ t: 'text', v: 'Do the first thing.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
        {
          id: randomUUID(),
          name: 'Never reached',
          instruction: [{ t: 'text', v: 'Do the second thing.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    };
    const { runId } = await seedRun(twoSteps);
    // A cancel raised by someone else WHILE the first step is in flight —
    // the per-node checkpoint must notice it before dispatching the
    // second step, not just at entry.
    const llm: ResolvedLlm = {
      provider: {
        complete: async () => {
          await db
            .updateTable('agent_runs')
            .set({ cancel_requested_at: sql`NOW()` })
            .where('id', '=', runId)
            .execute();
          return ok(finish('success'));
        },
      },
      modelConfigId: randomUUID(),
      providerName: 'anthropic',
      model: 'stub-model',
      maxOutputTokens: 512,
    };
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('canceled');
    expect(run.error).toBe('Canceled by request.');

    // Step 2 never ran — the checkpoint caught the cancel first.
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('step_id')
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
  });

  it('ends the run early — and quietly — when finish_step declares stop', async () => {
    const twoSteps: AgentStepsDoc = {
      version: 1,
      steps: [
        {
          id: randomUUID(),
          name: 'Check relevance',
          instruction: [{ t: 'text', v: 'If irrelevant, stop silently.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
        {
          id: randomUUID(),
          name: 'Never reached',
          instruction: [{ t: 'text', v: 'Do the work.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    };
    const { runId } = await seedRun(twoSteps);
    const finalized: unknown[] = [];
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () => stubMcp([], () => okToolResult),
      resolveLlm: async () => ok(stubLlm(() => finish('success', { stop: true, quiet: true }))),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
      onFinalized: async (run) => {
        finalized.push(run);
      },
    });
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    // Step 2 never ran — the declared stop ended the run.
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('step_id')
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
    // The finalize hook was told this stop wants silence.
    expect(finalized[0]).toMatchObject({ status: 'succeeded', quiet: true });
  });

  it('ends the run as stopped — not failed — when finish_step declares skipped', async () => {
    const twoSteps: AgentStepsDoc = {
      version: 1,
      steps: [
        {
          id: randomUUID(),
          name: 'Classify ticket type',
          instruction: [{ t: 'text', v: 'Pick the target project, or conclude none applies.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
        {
          id: randomUUID(),
          name: 'Never reached',
          instruction: [{ t: 'text', v: 'Create the ticket.' }],
          tool: null,
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    };
    const { runId } = await seedRun(twoSteps);
    const finalized: unknown[] = [];
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () => stubMcp([], () => okToolResult),
      resolveLlm: async () => ok(stubLlm(() => finish('skipped'))),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
      onFinalized: async (run) => {
        finalized.push(run);
      },
    });
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    // A graceful terminal: no error, no failure taxonomy, nothing red.
    expect(run.status).toBe('stopped');
    expect(run.error_kind).toBeNull();
    expect(run.error).toBeNull();

    // Step 2 never ran; the attempt records as a succeeded judgment whose
    // detail carries the why for the run timeline.
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['status', 'outcome', 'detail'])
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect(JSON.stringify(attempts[0].detail)).toContain('skipped');

    // The finalize hook sees the graceful status, marked quiet: no
    // notification, no chained agents.
    expect(finalized[0]).toMatchObject({ status: 'stopped', quiet: true });

    // Redelivering a stopped run is a no-op.
    await handler({ payload: { runId } });
    const attemptsAfter = await db
      .selectFrom('agent_run_steps')
      .select('id')
      .where('run_id', '=', runId)
      .execute();
    expect(attemptsAfter).toHaveLength(1);
    expect(finalized).toHaveLength(1);
  });

  it('stops after a step whose onSuccess is configured to stop', async () => {
    const doc = singleStep({ onSuccess: 'stop' });
    doc.steps.push({
      id: randomUUID(),
      name: 'Never reached',
      instruction: [{ t: 'text', v: 'Extra work.' }],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    });
    const { runId } = await seedRun(doc);
    const llm = stubLlm((_request, call) =>
      call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-42' })
        : finish('success', { saveValue: 'PROJ-42' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('step_id')
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);
  });

  it('stops immediately on a failure handled as exit', async () => {
    const { runId, agentId } = await seedRun(
      singleStep({
        maxAttempts: 5,
        failureHandling: [{ outcome: 'no-permission', action: 'exit' }],
      })
    );
    const llm = stubLlm((_request, call) =>
      call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-1' })
        : finish('failure', { code: 'no-permission' })
    );
    const denied: McpToolResult = {
      content: [{ type: 'text', text: 'You do not have permission (403)' }],
      isError: true,
      meta: {},
    };
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => denied)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('no-permission');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('attempt')
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(1);

    // The failed finalize bumps the durable failure tally (migration 050).
    const counter = await db
      .selectFrom('agent_run_counters')
      .select('failures')
      .where('agent_id', '=', agentId)
      .executeTakeFirstOrThrow();
    expect(counter.failures).toBe(1);
  });

  it('names the failed step in the warning it logs', async () => {
    // Regression: current_step_id was written to the row and never to the
    // in-memory run, so the name lookup read the value the run STARTED with
    // — null — and the interpolator left "{failedStep}" sitting in the
    // sentence. Nothing failed; the log was simply wrong, every time.
    resetRecordedLogs();
    const { runId } = await seedRun(
      singleStep({
        name: 'Send summary to WebEx space',
        maxAttempts: 1,
        failureHandling: [{ outcome: 'invalid-input', action: 'exit' }],
      })
    );
    const llm = stubLlm((_request, call) =>
      call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-1' })
        : finish('failure', { code: 'invalid-input' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => ({
        content: [{ type: 'text', text: 'no room id was available' }],
        isError: true,
        meta: {},
      }))
    );
    await handler({ payload: { runId } });

    const failure = recordedLogs().find((entry) => entry.template.includes('failed at step'));
    expect(failure).toBeDefined();
    if (!failure) return;
    const sentence = renderLog(failure);
    expect(sentence).toContain('failed at step "Send summary to WebEx space"');
    // The real assertion: no placeholder survives into the message. Any
    // brace here means an attribute the template names went missing.
    expect(sentence).not.toContain('{');
    expect(failure.attrs.failedStep).toBe('Send summary to WebEx space');
  });

  it('degrades to prose when the failed step cannot be named', async () => {
    // A run that fails before entering any step has no current_step_id to
    // resolve. That must read as a sentence, not as "{failedStep}".
    resetRecordedLogs();
    const { runId } = await seedRun(singleStep());
    await db
      .updateTable('agent_runs')
      .set({ steps_snapshot: JSON.stringify({ nonsense: true }) })
      .where('id', '=', runId)
      .execute();
    const handler = handlerWith(
      stubLlm(() => finish('success', {})),
      stubMcp([], () => ({ content: [], isError: false, meta: {} }))
    );
    await handler({ payload: { runId } });

    const failure = recordedLogs().find((entry) => entry.template.includes('failed at step'));
    expect(failure).toBeDefined();
    if (!failure) return;
    expect(renderLog(failure)).not.toContain('{');
    expect(failure.attrs.failedStep).toBe('an unnamed step');
  });

  it('records a declared success over an all-error tool as tool_error', async () => {
    const { runId } = await seedRun(singleStep({ maxAttempts: 1, failureHandling: [] }));
    const llm = stubLlm((_request, call) =>
      call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-999' })
        : finish('success', { saveValue: 'PROJ-999' })
    );
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => notFoundToolResult)
    );
    await handler({ payload: { runId } });

    const attempt = await db
      .selectFrom('agent_run_steps')
      .select(['status', 'outcome', 'outcome_code'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(attempt.status).toBe('failed');
    expect(attempt.outcome).toBe('tool_error');
    expect(attempt.outcome_code).toBe('not-found');
  });

  it('fails a run as config when the step tool is not in the owner projection', async () => {
    const { runId } = await seedRun(singleStep());
    const llm = stubLlm(() => finish('success'));
    const handler = handlerWith(
      llm,
      stubMcp(['outlook_send_mail'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('config');
    expect(run.error).toContain('jira_get_issue');
    // No attempt row: config failures spend nothing.
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('id')
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(0);
  });

  it('acknowledges a redelivered terminal run without re-executing', async () => {
    const { runId } = await seedRun(singleStep());
    const llm = stubLlm((_request, call) =>
      call === 0 ? useTool('jira_get_issue', {}) : finish('success')
    );
    let toolCallCount = 0;
    const mcp = stubMcp(['jira_get_issue'], () => {
      toolCallCount += 1;
      return okToolResult;
    });
    const handler = handlerWith(llm, mcp);
    await handler({ payload: { runId } });
    const callsAfterFirst = toolCallCount;
    await handler({ payload: { runId } });
    expect(toolCallCount).toBe(callsAfterFirst);
  });

  /* ------------------------------------------------------------------ */
  /* Branching (version 2 documents)                                     */
  /* ------------------------------------------------------------------ */

  const choosePath = (choice: 'yes' | 'no'): LlmResponse => ({
    content: [
      {
        type: 'tool_use',
        id: `tu_${Math.random().toString(36).slice(2)}`,
        name: 'choose_path',
        input: { choice, reason: `chose ${choice}` },
      },
    ],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  const reasoningStep = (name: string, overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    name,
    instruction: [{ t: 'text' as const, v: `Do: ${name}` }],
    tool: null,
    maxAttempts: 1,
    failureHandling: [],
    ...overrides,
  });

  function branchDoc(options: { elseSteps?: object[]; branchAttempts?: number } = {}): {
    doc: AgentStepsDoc;
    ids: { branch: string; inYes: string; after: string };
  } {
    const inYes = reasoningStep('in yes path');
    const after = reasoningStep('after the branch');
    const branchId = randomUUID();
    const doc = {
      version: 2,
      steps: [
        {
          id: branchId,
          kind: 'branch',
          name: 'Anything urgent?',
          condition: [{ t: 'text', v: 'Is anything urgent in the subject?' }],
          paths: [
            { id: randomUUID(), name: 'Yes', steps: [inYes] },
            { id: randomUUID(), name: 'Otherwise', steps: options.elseSteps ?? [] },
          ],
          maxAttempts: options.branchAttempts ?? 2,
        },
        after,
      ],
    };
    if (!isAgentStepsDoc(doc)) throw new Error('fixture is not a valid v2 doc');
    return { doc, ids: { branch: branchId, inYes: inYes.id, after: after.id } };
  }

  it('takes the yes path, then continues after the branch', async () => {
    const { doc, ids } = branchDoc();
    const { runId } = await seedRun(doc);
    // Call order: choose_path, then finish for "in yes", then finish for "after".
    const llm = stubLlm((_request, call) => (call === 0 ? choosePath('yes') : finish('success')));
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    expect(attempts.map((row) => row.step_id)).toEqual([ids.branch, ids.inYes, ids.after]);
    // Pre-order ordinals: branch 0, yes-child 1, after 2 (the empty else
    // path holds no nodes to number).
    expect(attempts.map((row) => row.step_index)).toEqual([0, 1, 2]);
    const branchRow = attempts[0];
    expect(branchRow.outcome).toBe('path_chosen');
    expect(branchRow.tool_call_count).toBe(0);
    const detail: { chosenPathName?: unknown; llmSummary?: unknown } =
      typeof branchRow.detail === 'object' &&
      branchRow.detail !== null &&
      !Array.isArray(branchRow.detail)
        ? branchRow.detail
        : {};
    expect(detail.chosenPathName).toBe('Yes');
    expect(detail.llmSummary).toBe('chose yes');
  });

  it('falls through an empty else path straight to the step after the branch', async () => {
    const { doc, ids } = branchDoc();
    const { runId } = await seedRun(doc);
    const llm = stubLlm((_request, call) => (call === 0 ? choosePath('no') : finish('success')));
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'status'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    // The yes-path step never ran; only the branch decision and the tail step.
    expect(attempts.map((row) => row.step_id)).toEqual([ids.branch, ids.after]);
  });

  it('fails the run as step_failed when the model never chooses within the budget', async () => {
    const { doc, ids } = branchDoc({ branchAttempts: 2 });
    const { runId } = await seedRun(doc);
    // Never a valid choose_path call — plain text every turn.
    const llm = stubLlm(() => ({
      content: [{ type: 'text', text: 'hmm, unsure' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error', 'current_step_id'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('step_failed');
    expect(run.error).toContain('Anything urgent?');
    expect(run.current_step_id).toBe(ids.branch);

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['status', 'outcome'])
      .where('run_id', '=', runId)
      .execute();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((row) => row.status === 'failed')).toBe(true);
  });

  it('reuses a decided branch on redelivery instead of asking the model again', async () => {
    const { doc, ids } = branchDoc();
    const { runId } = await seedRun(doc);
    let chooseCalls = 0;
    const llm = stubLlm((request, call) => {
      // A branch turn offers choose_path — whether or not it is the forced
      // tool that turn (see forcedName above).
      const forced = request.tools.some((tool) => tool.name === 'choose_path');
      if (forced) {
        chooseCalls += 1;
        return choosePath('yes');
      }
      // Fail the yes-path step's single attempt so the run fails mid-path…
      return call < 2 ? finish('failure', { code: 'other' }) : finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const afterFirst = await db
      .selectFrom('agent_runs')
      .select(['status', 'current_step_id'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(afterFirst.status).toBe('failed');
    expect(afterFirst.current_step_id).toBe(ids.inYes);
    expect(chooseCalls).toBe(1);

    // …then force it back to running and redeliver: resume must land inside
    // the yes path (the ancestor chain from current_step_id) and must NOT
    // re-ask choose_path.
    await db
      .updateTable('agent_runs')
      .set({ status: 'running', error_kind: null, error: null, finished_at: null })
      .where('id', '=', runId)
      .execute();
    await handler({ payload: { runId } });

    const afterSecond = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    // The yes-path step's budget (1) is spent, so the resumed run fails the
    // same way — the assertion that matters is chooseCalls staying at 1.
    expect(afterSecond.status).toBe('failed');
    expect(chooseCalls).toBe(1);
  });

  /* ------------------------------------------------------------------ */
  /* Loops, groups, n-way branches (version 3 documents)                 */
  /* ------------------------------------------------------------------ */

  const loopDecision = (choice: 'finished' | 'continue'): LlmResponse => ({
    content: [
      {
        type: 'tool_use',
        id: `tu_${Math.random().toString(36).slice(2)}`,
        name: 'loop_decision',
        input: { choice, reason: `decided ${choice}` },
      },
    ],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  const plainText: LlmResponse = {
    content: [{ type: 'text', text: 'hmm, unsure' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  /**
   * Which decision this request is asking for. Not the forced tool name:
   * condition turns offer the decision tool ALONGSIDE the free resolve_time
   * and use toolChoice 'any', so the forced name is only set on the final
   * turn. The offered set is what actually identifies the request.
   */
  const forcedName = (request: LlmRequest): string | null => {
    if (typeof request.toolChoice === 'object' && request.toolChoice !== null) {
      return request.toolChoice.name;
    }
    const decision = request.tools.find((tool) => tool.name !== 'resolve_time');
    return decision ? decision.name : null;
  };

  const firstText = (request: LlmRequest): string => {
    for (const message of request.messages) {
      for (const block of message.content) {
        if (block.type === 'text') return block.text;
      }
    }
    return '';
  };

  function foreachDoc(): {
    doc: AgentStepsDoc;
    ids: { gather: string; loop: string; work: string; report: string };
  } {
    const gather = reasoningStep('gather the items', { saveAs: 'items' });
    const work = {
      id: randomUUID(),
      name: 'work one item',
      instruction: [
        { t: 'text' as const, v: 'Handle ' },
        { t: 'var' as const, name: 'item' },
      ],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
      saveAs: 'note',
    };
    const report = {
      id: randomUUID(),
      name: 'report',
      instruction: [
        { t: 'text' as const, v: 'Report from ' },
        { t: 'var' as const, name: 'notes' },
      ],
      tool: null,
      maxAttempts: 1,
      failureHandling: [],
    };
    const loopId = randomUUID();
    const doc = {
      version: 3,
      steps: [
        gather,
        {
          id: loopId,
          kind: 'loop',
          mode: 'foreach',
          name: 'work the queue',
          itemsVar: 'items',
          itemVar: 'item',
          maxIterations: 10,
          collectFrom: 'note',
          collectVar: 'notes',
          steps: [work],
        },
        report,
      ],
    };
    if (!isAgentStepsDoc(doc)) throw new Error('fixture is not a valid v3 doc');
    return { doc, ids: { gather: gather.id, loop: loopId, work: work.id, report: report.id } };
  }

  it('runs a for-each loop per item, rebinding the item variable, and collects filter+expand results', async () => {
    const { doc, ids } = foreachDoc();
    const { runId } = await seedRun(doc);
    const requests: LlmRequest[] = [];
    // gather saves a 3-item list; iteration 1 saves one value, iteration 2
    // saves nothing (a filtering round), iteration 3 saves TWO (expanding).
    const llm = stubLlm((request, call) => {
      requests.push(request);
      if (call === 0) return finish('success', { saveItems: ['one', 'two', 'three'] });
      if (call === 1) return finish('success', { saveValue: 'note-one' });
      if (call === 2) return finish('success');
      if (call === 3) return finish('success', { saveItems: ['n3a', 'n3b'] });
      return finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    // Rows in the run views' order: gather, then the body once per round
    // (iteration 1..3), then the tail — non-loop rows at iteration 0.
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'step_index', 'iteration', 'attempt', 'status'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .orderBy('iteration')
      .orderBy('attempt')
      .execute();
    expect(attempts.map((row) => [row.step_id, row.iteration])).toEqual([
      [ids.gather, 0],
      [ids.work, 1],
      [ids.work, 2],
      [ids.work, 3],
      [ids.report, 0],
    ]);
    expect(attempts.every((row) => row.status === 'succeeded')).toBe(true);

    // The item variable rebound per round: each body prompt names its item.
    expect(firstText(requests[1])).toContain('Handle one');
    expect(firstText(requests[2])).toContain('Handle two');
    expect(firstText(requests[3])).toContain('Handle three');
    // The collected list holds what each round ACTUALLY saved — one entry,
    // none, then two: smaller AND larger than the per-round input.
    expect(firstText(requests[4])).toContain('Report from note-one\nn3a\nn3b');
  });

  it('skips a for-each loop over an empty list without failing', async () => {
    const { doc, ids } = foreachDoc();
    const { runId } = await seedRun(doc);
    // gather saves NO list at all.
    const llm = stubLlm(() => finish('success'));
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    const attempts = await db
      .selectFrom('agent_run_steps')
      .select('step_id')
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    // The body never ran; the flow continued straight to the tail.
    expect(attempts.map((row) => row.step_id)).toEqual([ids.gather, ids.report]);
  });

  function untilDoc(maxIterations: number): {
    doc: AgentStepsDoc;
    ids: { loop: string; ping: string };
  } {
    const ping = reasoningStep('ping once');
    const loopId = randomUUID();
    const doc = {
      version: 3,
      steps: [
        {
          id: loopId,
          kind: 'loop',
          mode: 'until',
          name: 'page until dry',
          condition: [{ t: 'text', v: 'Did the last round come back empty?' }],
          maxAttempts: 2,
          maxIterations,
          steps: [ping],
        },
      ],
    };
    if (!isAgentStepsDoc(doc)) throw new Error('fixture is not a valid v3 doc');
    return { doc, ids: { loop: loopId, ping: ping.id } };
  }

  it('runs an until loop per decision and records loop_decided rows per round', async () => {
    const { doc, ids } = untilDoc(5);
    const { runId } = await seedRun(doc);
    let decisions = 0;
    const llm = stubLlm((request) => {
      if (forcedName(request) === 'loop_decision') {
        decisions += 1;
        return loopDecision(decisions >= 3 ? 'finished' : 'continue');
      }
      return finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    expect(decisions).toBe(3);

    const loopRows = await db
      .selectFrom('agent_run_steps')
      .select(['iteration', 'outcome', 'detail'])
      .where('run_id', '=', runId)
      .where('step_id', '=', ids.loop)
      .orderBy('iteration')
      .execute();
    expect(loopRows.map((row) => row.iteration)).toEqual([1, 2, 3]);
    expect(loopRows.every((row) => row.outcome === 'loop_decided')).toBe(true);
    expect(JSON.stringify(loopRows[2].detail)).toContain('finished');

    const pingRows = await db
      .selectFrom('agent_run_steps')
      .select('iteration')
      .where('run_id', '=', runId)
      .where('step_id', '=', ids.ping)
      .orderBy('iteration')
      .execute();
    expect(pingRows.map((row) => row.iteration)).toEqual([1, 2, 3]);
  });

  it('fails an until loop that reaches its round limit with the condition unmet', async () => {
    const { doc } = untilDoc(2);
    const { runId } = await seedRun(doc);
    const llm = stubLlm((request) =>
      forcedName(request) === 'loop_decision' ? loopDecision('continue') : finish('success')
    );
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('step_failed');
    expect(run.error).toContain('reached its limit of 2');
  });

  it('fast-forwards a resumed run through recorded iterations with zero model calls', async () => {
    const { doc, ids } = untilDoc(5);
    const { runId } = await seedRun(doc);
    let decisions = 0;
    const llm = stubLlm((request) => {
      if (forcedName(request) === 'loop_decision') {
        decisions += 1;
        return loopDecision(decisions >= 3 ? 'finished' : 'continue');
      }
      return finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });
    const rowsAfterFirst = await db
      .selectFrom('agent_run_steps')
      .select('id')
      .where('run_id', '=', runId)
      .execute();

    // Simulate a crash after the last row was written: back to running,
    // positioned inside the loop. Resume must replay every iteration's
    // succeeded rows and recorded decisions — rows are the memory — and
    // re-finalize without ONE model call.
    await db
      .updateTable('agent_runs')
      .set({ status: 'running', current_step_id: ids.ping, finished_at: null })
      .where('id', '=', runId)
      .execute();
    let resumeCalls = 0;
    const strictLlm = stubLlm(() => {
      resumeCalls += 1;
      return finish('success');
    });
    const resumeHandler = handlerWith(
      strictLlm,
      stubMcp([], () => okToolResult)
    );
    await resumeHandler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    expect(resumeCalls).toBe(0);
    const rowsAfterResume = await db
      .selectFrom('agent_run_steps')
      .select('id')
      .where('run_id', '=', runId)
      .execute();
    expect(rowsAfterResume).toHaveLength(rowsAfterFirst.length);
  });

  it('fails the run with a guard when the attempt-row budget is exhausted', async () => {
    const { runId } = await seedRun({ version: 1, steps: [reasoningStep('never runs')] });
    // 250 pre-existing rows (as if a pathological loop had spent them all).
    const syntheticStep = randomUUID();
    const synthetic = Array.from({ length: 250 }, (_, index) => ({
      id: randomUUID(),
      tenant_id: tenantId,
      run_id: runId,
      step_id: syntheticStep,
      step_index: 0,
      attempt: index + 1,
      iteration: 0,
      status: 'failed',
    }));
    for (let at = 0; at < synthetic.length; at += 50) {
      await db
        .insertInto('agent_run_steps')
        .values(synthetic.slice(at, at + 50))
        .execute();
    }
    const llm = stubLlm(() => finish('success'));
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('guard');
    expect(run.error).toContain('execution budget');
  });

  it('routes a 3-way branch by number under the router prompt; the 2-way def stays frozen', async () => {
    const inSecond = reasoningStep('in the second route');
    const after = reasoningStep('after the router');
    const threeWay = {
      version: 3,
      steps: [
        {
          id: randomUUID(),
          kind: 'branch',
          name: 'Which kind?',
          condition: [{ t: 'text', v: 'Bug, question, or something else?' }],
          paths: [
            { id: randomUUID(), name: 'A bug', steps: [] },
            { id: randomUUID(), name: 'A question', steps: [inSecond] },
            { id: randomUUID(), name: 'Something else', steps: [] },
          ],
          maxAttempts: 2,
        },
        after,
      ],
    };
    if (!isAgentStepsDoc(threeWay)) throw new Error('fixture is not a valid v3 doc');
    const { runId } = await seedRun(threeWay);
    const requests: LlmRequest[] = [];
    const llm = stubLlm((request) => {
      requests.push(request);
      if (forcedName(request) === 'choose_path') {
        return {
          content: [
            {
              type: 'tool_use',
              id: `tu_${Math.random().toString(36).slice(2)}`,
              name: 'choose_path',
              input: { choice: '2', reason: 'reads like a question' },
            },
          ],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    // The router request: numbered enum, router framing.
    const chooseRequest = requests.find((request) => forcedName(request) === 'choose_path');
    expect(chooseRequest).toBeDefined();
    expect(chooseRequest!.tools[0].inputSchema).toEqual({
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: ['1', '2', '3'],
          description: expect.stringContaining('3 = Something else'),
        },
        reason: {
          type: 'string',
          description: 'One or two sentences on why, written for the agent owner.',
        },
      },
      required: ['choice', 'reason'],
    });
    expect(chooseRequest!.system).toContain('routing one decision');

    const attempts = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'iteration', 'detail'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    expect(attempts.map((row) => row.step_id)).toEqual([
      threeWay.steps[0].id,
      inSecond.id,
      after.id,
    ]);
    expect(JSON.stringify(attempts[0].detail)).toContain('A question');

    // And the two-path def has not drifted a byte for v2 agents.
    const { doc } = branchDoc();
    const { runId: v2RunId } = await seedRun(doc);
    const v2Requests: LlmRequest[] = [];
    const v2Llm = stubLlm((request) => {
      v2Requests.push(request);
      return forcedName(request) === 'choose_path' ? choosePath('yes') : finish('success');
    });
    await handlerWith(
      v2Llm,
      stubMcp([], () => okToolResult)
    )({ payload: { runId: v2RunId } });
    const v2Choose = v2Requests.find((request) => forcedName(request) === 'choose_path');
    expect(v2Choose!.tools[0]).toEqual({
      name: 'choose_path',
      description: 'Decide which path the automation takes. Call exactly once.',
      inputSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'string',
            enum: ['yes', 'no'],
            description: 'yes → the condition holds; no → it does not.',
          },
          reason: {
            type: 'string',
            description: 'One or two sentences on why, written for the agent owner.',
          },
        },
        required: ['choice', 'reason'],
      },
    });
    expect(v2Choose!.system).toContain('yes/no branch');
    // …and its rows all sit at iteration 0, exactly as before v3.
    const v2Rows = await db
      .selectFrom('agent_run_steps')
      .select('iteration')
      .where('run_id', '=', v2RunId)
      .execute();
    expect(v2Rows.every((row) => row.iteration === 0)).toBe(true);
  });

  it('decides a branch inside a loop fresh on every iteration', async () => {
    const actYes = reasoningStep('escalate it');
    const actNo = reasoningStep('acknowledge it');
    const gather = reasoningStep('gather', { saveAs: 'items' });
    const branchId = randomUUID();
    const doc = {
      version: 3,
      steps: [
        gather,
        {
          id: randomUUID(),
          kind: 'loop',
          mode: 'foreach',
          name: 'triage each',
          itemsVar: 'items',
          itemVar: 'item',
          maxIterations: 5,
          steps: [
            {
              id: branchId,
              kind: 'branch',
              name: 'Urgent?',
              condition: [
                { t: 'text', v: 'Is ' },
                { t: 'var', name: 'item' },
                { t: 'text', v: ' urgent?' },
              ],
              paths: [
                { id: randomUUID(), name: 'Yes', steps: [actYes] },
                { id: randomUUID(), name: 'Otherwise', steps: [actNo] },
              ],
              maxAttempts: 2,
            },
          ],
        },
      ],
    };
    if (!isAgentStepsDoc(doc)) throw new Error('fixture is not a valid v3 doc');
    const { runId } = await seedRun(doc);
    let chooses = 0;
    const llm = stubLlm((request, call) => {
      if (forcedName(request) === 'choose_path') {
        chooses += 1;
        return choosePath(chooses === 1 ? 'yes' : 'no');
      }
      return call === 0 ? finish('success', { saveItems: ['first', 'second'] }) : finish('success');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    // Decided per iteration, not replayed across them.
    expect(chooses).toBe(2);

    const rows = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'iteration'])
      .where('run_id', '=', runId)
      .orderBy('iteration')
      .orderBy('step_index')
      .execute();
    expect(rows.filter((row) => row.step_id === branchId).map((row) => row.iteration)).toEqual([
      1, 2,
    ]);
    expect(rows.filter((row) => row.step_id === actYes.id).map((row) => row.iteration)).toEqual([
      1,
    ]);
    expect(rows.filter((row) => row.step_id === actNo.id).map((row) => row.iteration)).toEqual([2]);
  });

  function failureRouteDoc(failureSteps: ReturnType<typeof reasoningStep>[] | undefined): {
    doc: AgentStepsDoc;
    ids: { branch: string; after: string; cleanup: string | null };
  } {
    const after = reasoningStep('after the branch');
    const cleanup = failureSteps?.[0] ?? null;
    const branchId = randomUUID();
    const doc = {
      version: 3,
      steps: [
        {
          id: branchId,
          kind: 'branch',
          name: 'Decides badly',
          condition: [{ t: 'text', v: 'Is it so?' }],
          paths: [
            { id: randomUUID(), name: 'Yes', steps: [] },
            { id: randomUUID(), name: 'Otherwise', steps: [] },
          ],
          ...(failureSteps !== undefined
            ? {
                failurePath: { id: randomUUID(), name: 'On failure', steps: failureSteps },
              }
            : {}),
          maxAttempts: 1,
        },
        after,
      ],
    };
    if (!isAgentStepsDoc(doc)) throw new Error('fixture is not a valid v3 doc');
    return {
      doc,
      ids: { branch: branchId, after: after.id, cleanup: cleanup?.id ?? null },
    };
  }

  it('takes the failure route when branch evaluation exhausts its attempts', async () => {
    const cleanup = reasoningStep('clean up the mess');
    const { doc, ids } = failureRouteDoc([cleanup]);
    const { runId } = await seedRun(doc);
    // choose_path never answers usably; everything else succeeds.
    const llm = stubLlm((request) =>
      forcedName(request) === 'choose_path' ? plainText : finish('success')
    );
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    // The failure route absorbed the evaluator's failure — the run went on.
    expect(run.status).toBe('succeeded');

    const rows = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'status'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    expect(rows.map((row) => [row.step_id, row.status])).toEqual([
      [ids.branch, 'failed'],
      [ids.cleanup, 'succeeded'],
      [ids.after, 'succeeded'],
    ]);
  });

  it('lets a branch condition compute a date before it decides', async () => {
    // The arithmetic a condition should never do in its head: "was this
    // before yesterday 19:00 in Los Angeles?"
    const { doc, ids } = branchDoc();
    const { runId } = await seedRun(doc);
    let lookups = 0;
    let sawResult = '';
    const llm = stubLlm((request) => {
      if (forcedName(request) !== 'choose_path') return finish('success');
      for (const message of request.messages) {
        for (const block of message.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            sawResult = block.content;
          }
        }
      }
      if (!sawResult) {
        lookups += 1;
        return useTool('resolve_time', {
          timezone: 'America/Los_Angeles',
          amount: -1,
          unit: 'day',
          atTime: '19:00',
        });
      }
      return choosePath('yes');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    expect(lookups).toBe(1);
    // Answered in process, with a real instant — not routed anywhere.
    expect(sawResult).toContain('"iso"');
    expect(sawResult).toContain('America/Los_Angeles');

    // The branch still decided, and the instant it used is on the record.
    const branchRow = await db
      .selectFrom('agent_run_steps')
      .select(['outcome', 'detail'])
      .where('run_id', '=', runId)
      .where('step_id', '=', ids.branch)
      .executeTakeFirstOrThrow();
    expect(branchRow.outcome).toBe('path_chosen');
    expect(JSON.stringify(branchRow.detail)).toContain('timeLookups');
  });

  it('forces the verdict on the last turn even if the condition keeps asking the time', async () => {
    // A model that only ever looks up dates must still land on a path
    // rather than burning the attempt budget.
    const { doc } = branchDoc({ branchAttempts: 1 });
    const { runId } = await seedRun(doc);
    let dateCalls = 0;
    const llm = stubLlm((request) => {
      if (forcedName(request) !== 'choose_path') return finish('success');
      // On the final turn resolve_time is not offered at all — the only
      // callable tool is the decision.
      if (request.tools.some((tool) => tool.name === 'resolve_time')) {
        dateCalls += 1;
        return useTool('resolve_time', { timezone: 'UTC' });
      }
      return choosePath('no');
    });
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    // Bounded: it asked on every turn that offered it, then had to decide.
    expect(dateCalls).toBe(CONDITION_TURNS_IN_TEST - 1);
  });

  it('swallows the failure and continues when the failure route is empty', async () => {
    const { doc, ids } = failureRouteDoc([]);
    const { runId } = await seedRun(doc);
    const llm = stubLlm((request) =>
      forcedName(request) === 'choose_path' ? plainText : finish('success')
    );
    const handler = handlerWith(
      llm,
      stubMcp([], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    const rows = await db
      .selectFrom('agent_run_steps')
      .select(['step_id', 'status'])
      .where('run_id', '=', runId)
      .orderBy('step_index')
      .execute();
    expect(rows.map((row) => [row.step_id, row.status])).toEqual([
      [ids.branch, 'failed'],
      [ids.after, 'succeeded'],
    ]);
  });

  it('a terminal failure node ends the run failed AND quiet, delivering its own notifications', async () => {
    const terminalId = randomUUID();
    const doc: AgentStepsDoc = {
      version: 4,
      steps: [
        {
          id: terminalId,
          kind: 'terminal',
          name: 'Give up',
          result: 'failure',
          message: [
            { t: 'text', v: 'Could not handle: ' },
            { t: 'var', name: 'trigger.subject' },
          ],
          notifyEmail: true,
          notifyWebex: true,
        },
      ],
    };
    const { runId } = await seedRun(doc);
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const mcp: McpClient = {
      initialize: async () => undefined,
      listTools: async () =>
        ['outlook_send_mail', 'webex_note_to_self'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
        })),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return okToolResult;
      },
    };
    const finalized: unknown[] = [];
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () => mcp,
      // Terminal nodes are deterministic — the model must never be asked.
      resolveLlm: async () =>
        ok(
          stubLlm(() => {
            throw new Error('terminal nodes must not call the model');
          })
        ),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
      onFinalized: async (run) => {
        finalized.push(run);
      },
    });
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('step_failed');
    expect(run.error).toContain('Give up');
    expect(run.error).toContain('PROJ-42 is broken');

    // quiet: the node's own channels are the notification — the generic
    // run.failed mail must not double up.
    expect(finalized[0]).toMatchObject({ status: 'failed', quiet: true });

    const rows = await db
      .selectFrom('agent_run_steps')
      .selectAll()
      .where('run_id', '=', runId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].outcome).toBe('terminal');
    expect(rows[0].tool_call_count).toBe(2);

    // Both channels got the RENDERED message — real context, not a generic
    // "your agent failed".
    const mail = calls.find((call) => call.name === 'outlook_send_mail');
    expect(mail?.args).toMatchObject({ to: ['owner@example.com'] });
    expect(String(mail?.args.body)).toContain('Could not handle: PROJ-42 is broken');
    const note = calls.find((call) => call.name === 'webex_note_to_self');
    expect(String(note?.args.markdown)).toContain('Could not handle: PROJ-42 is broken');
  });

  it('a silent stop terminal ends the run stopped with no delivery', async () => {
    const doc: AgentStepsDoc = {
      version: 4,
      steps: [
        {
          id: randomUUID(),
          kind: 'terminal',
          name: 'Nothing to do',
          result: 'stop',
          message: [],
          notifyEmail: false,
          notifyWebex: false,
        },
      ],
    };
    const { runId } = await seedRun(doc);
    const calls: string[] = [];
    const finalized: unknown[] = [];
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () =>
        stubMcp(['outlook_send_mail', 'webex_note_to_self'], (name) => {
          calls.push(name);
          return okToolResult;
        }),
      resolveLlm: async () => ok(stubLlm(() => finish('success'))),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
      onFinalized: async (run) => {
        finalized.push(run);
      },
    });
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('stopped');
    expect(run.error).toBeNull();
    expect(calls).toEqual([]);
    expect(finalized[0]).toMatchObject({ status: 'stopped', quiet: true });

    const rows = await db
      .selectFrom('agent_run_steps')
      .select(['status', 'outcome'])
      .where('run_id', '=', runId)
      .execute();
    expect(rows).toEqual([{ status: 'stopped', outcome: 'terminal' }]);
  });

  it('injects guardrails into the system and step prompts, in full', async () => {
    const { runId, agentId } = await seedRun(singleStep());
    const guardrails = 'Never fabricate numbers. Draft only — never send anything.';
    await db.updateTable('agents').set({ guardrails }).where('id', '=', agentId).execute();

    const seen: LlmRequest[] = [];
    const llm = stubLlm((request, call) => {
      seen.push(request);
      return call === 0
        ? useTool('jira_get_issue', { issueKey: 'PROJ-42' })
        : finish('success', { saveValue: 'PROJ-42' });
    });
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    expect(seen.length).toBeGreaterThan(0);
    // The system prompt carries the override framing ONLY for agents with
    // guardrails; the user message carries the document itself, unclipped.
    expect(seen[0].system).toContain('the guardrails win');
    const firstUser = JSON.stringify(seen[0].messages);
    expect(firstUser).toContain('Standing guardrails');
    expect(firstUser).toContain('Never fabricate numbers.');
  });

  it('fails the run as a guard stop when a step uses a blocked skill', async () => {
    const { runId, agentId } = await seedRun(singleStep());
    await db
      .updateTable('agents')
      .set({ blocked_tools: JSON.stringify(['jira_get_issue']) })
      .where('id', '=', agentId)
      .execute();

    const llm = stubLlm(() => {
      throw new Error('a blocked step must fail before any model call');
    });
    const handler = handlerWith(
      llm,
      stubMcp(['jira_get_issue'], () => okToolResult)
    );
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error_kind', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('guard');
    expect(run.error).toContain('blocked');
  });

  describe('approval nodes', () => {
    const terminalNode = (
      result: 'success' | 'failure' | 'stop',
      message: InstructionSegment[] = []
    ): TerminalStep => ({
      id: randomUUID(),
      kind: 'terminal',
      name: `end-${result}`,
      result,
      message,
      notifyEmail: false,
      notifyWebex: false,
    });

    function approvalDoc(
      options: {
        mode?: 'approve' | 'input';
        saveAs?: string;
        fields?: ApprovalStep['fields'];
        timeoutHours?: number;
        notifyEmail?: boolean;
        notifyWebex?: boolean;
        onApproved?: AgentStepNode[];
        onDeclined?: AgentStepNode[];
        onTimeout?: AgentStepNode[];
      } = {}
    ): { doc: AgentStepsDoc; approvalId: string } {
      const approval: ApprovalStep = {
        id: randomUUID(),
        kind: 'approval',
        name: 'OK to send?',
        message: [
          { t: 'text', v: 'Send the report for ' },
          { t: 'var', name: 'trigger.subject' },
          { t: 'text', v: '?' },
        ],
        mode: options.mode ?? 'approve',
        ...(options.saveAs ? { saveAs: options.saveAs } : {}),
        ...(options.fields ? { fields: options.fields } : {}),
        timeoutHours: options.timeoutHours ?? 72,
        notifyEmail: options.notifyEmail ?? false,
        notifyWebex: options.notifyWebex ?? false,
        onApproved: { id: randomUUID(), name: 'Approved', steps: options.onApproved ?? [] },
        onDeclined: { id: randomUUID(), name: 'Declined', steps: options.onDeclined ?? [] },
        onTimeout: { id: randomUUID(), name: 'No answer', steps: options.onTimeout ?? [] },
      };
      const doc: AgentStepsDoc = { version: 5, steps: [approval] };
      if (!isAgentStepsDoc(doc)) throw new Error('test doc is not a valid v5 steps doc');
      return { doc, approvalId: approval.id };
    }

    /** Approval nodes are deterministic — any model call is a bug. */
    const noModel = () =>
      stubLlm(() => {
        throw new Error('approval nodes must not call the model');
      });

    const cardOf = async (runId: string) =>
      db
        .selectFrom('actionable_items')
        .selectAll()
        .where('run_id', '=', runId)
        .executeTakeFirstOrThrow();

    it('parks the run waiting behind a card and delivers the notifications', async () => {
      const { doc, approvalId } = approvalDoc({
        notifyEmail: true,
        notifyWebex: true,
        timeoutHours: 4,
      });
      const { runId } = await seedRun(doc);
      const calls: { name: string; args: Record<string, unknown> }[] = [];
      const mcp: McpClient = {
        initialize: async () => undefined,
        listTools: async () =>
          ['outlook_send_mail', 'webex_note_to_self'].map((name) => ({
            name,
            description: name,
            inputSchema: { type: 'object' },
          })),
        callTool: async (name, args) => {
          calls.push({ name, args });
          return okToolResult;
        },
      };
      const before = Date.now();
      await handlerWith(noModel(), mcp)({ payload: { runId } });

      const run = await db
        .selectFrom('agent_runs')
        .select(['status', 'waiting_until', 'error'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('waiting');
      expect(run.error).toBeNull();
      // The deadline is the node's own wait, not the org cap.
      const waitingUntil = new Date(run.waiting_until ?? 0).getTime();
      expect(waitingUntil).toBeGreaterThanOrEqual(before + 3.9 * 3_600_000);
      expect(waitingUntil).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000);

      const rows = await db
        .selectFrom('agent_run_steps')
        .select(['step_id', 'status', 'outcome'])
        .where('run_id', '=', runId)
        .execute();
      expect(rows).toEqual([{ step_id: approvalId, status: 'waiting', outcome: 'approval' }]);

      const card = await cardOf(runId);
      expect(card.status).toBe('suggested');
      expect(card.kind).toBe('approval');
      expect(card.owner_subject).toBe(subject);
      expect(card.step_id).toBe(approvalId);
      expect(card.summary).toContain('PROJ-42 is broken');

      // Both channels got the rendered question.
      const mail = calls.find((call) => call.name === 'outlook_send_mail');
      expect(mail?.args).toMatchObject({ to: ['owner@example.com'] });
      expect(String(mail?.args.body)).toContain('Send the report for PROJ-42 is broken?');
      const note = calls.find((call) => call.name === 'webex_note_to_self');
      expect(String(note?.args.markdown)).toContain('Send the report for PROJ-42 is broken?');
    });

    it('re-parks a spurious wake without extending the deadline or re-notifying', async () => {
      const { doc } = approvalDoc({ notifyEmail: true, timeoutHours: 4 });
      const { runId } = await seedRun(doc);
      const calls: string[] = [];
      const mcp = stubMcp(['outlook_send_mail', 'webex_note_to_self'], (name) => {
        calls.push(name);
        return okToolResult;
      });
      const handler = handlerWith(noModel(), mcp);
      await handler({ payload: { runId } });
      const first = await db
        .selectFrom('agent_runs')
        .select('waiting_until')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(calls).toEqual(['outlook_send_mail']);

      // A duplicate delivery while the owner is still thinking.
      await handler({ payload: { runId } });

      const again = await db
        .selectFrom('agent_runs')
        .select(['status', 'waiting_until'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(again.status).toBe('waiting');
      expect(new Date(again.waiting_until ?? 0).toISOString()).toBe(
        new Date(first.waiting_until ?? 0).toISOString()
      );
      // Exactly one card, exactly one notification.
      const cards = await db
        .selectFrom('actionable_items')
        .select('id')
        .where('run_id', '=', runId)
        .execute();
      expect(cards).toHaveLength(1);
      expect(calls).toEqual(['outlook_send_mail']);
    });

    it('tells the steps after an approval that it was approved, by whom, and when', async () => {
      // The bug this covers cost a real run: the owner clicked Approve, the
      // engine routed correctly into onApproved, and the very next step
      // refused to act — its prompt listed `approval.link` and nothing
      // else, so an agent whose guardrails demand explicit approval saw a
      // request for one and no evidence of one. Routing is invisible to a
      // model; only variables reach the prompt.
      const acting = {
        id: randomUUID(),
        name: 'Do the approved thing',
        instruction: [{ t: 'text' as const, v: 'Proceed.' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      };
      const { doc } = approvalDoc({ onApproved: [acting] });
      const { runId } = await seedRun(doc);
      const prompts: string[] = [];
      const llm = stubLlm((request) => {
        for (const message of request.messages) {
          for (const block of message.content) {
            if (block.type === 'text') prompts.push(block.text);
          }
        }
        return finish('success');
      });
      const handler = handlerWith(
        llm,
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });

      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({
          status: 'approved',
          result: JSON.stringify({ decidedBy: 'owner@example.com' }),
          decided_at: sql`NOW()`,
        })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      const run = await db
        .selectFrom('agent_runs')
        .select('status')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('succeeded');

      // The acting step's prompt states the approval as a fact, names the
      // decider, and is not merely a link to go ask for one.
      const acted = prompts.join('\n');
      expect(acted).toContain('approval.decision: approved');
      expect(acted).toMatch(/The owner approved .*owner@example\.com/);
      expect(acted).toContain('approval.decidedBy: owner@example.com');
    });

    it('says plainly when a decision was a decline rather than an approval', async () => {
      const acting = {
        id: randomUUID(),
        name: 'Runs on the declined path',
        instruction: [{ t: 'text' as const, v: 'Clean up.' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      };
      const { doc } = approvalDoc({ onDeclined: [acting] });
      const { runId } = await seedRun(doc);
      const prompts: string[] = [];
      const llm = stubLlm((request) => {
        for (const message of request.messages) {
          for (const block of message.content) {
            if (block.type === 'text') prompts.push(block.text);
          }
        }
        return finish('success');
      });
      const handler = handlerWith(
        llm,
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });

      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({ status: 'declined', decided_at: sql`NOW()` })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      const acted = prompts.join('\n');
      expect(acted).toContain('approval.decision: declined');
      // A step on the declined path must not be able to read the variable
      // as permission — the wording has to carry the negative.
      expect(acted).toContain('DECLINED');
    });

    it('an answered card binds the answer and routes the approved path', async () => {
      const { doc, approvalId } = approvalDoc({
        mode: 'input',
        saveAs: 'the decision',
        onApproved: [
          terminalNode('failure', [
            { t: 'text', v: 'Answer was: ' },
            { t: 'var', name: 'the decision' },
          ]),
        ],
      });
      const { runId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });

      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({
          status: 'approved',
          result: JSON.stringify({ answer: 'ship it' }),
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
        })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      // Routed into onApproved, whose terminal message SAW the bound answer.
      const run = await db
        .selectFrom('agent_runs')
        .select(['status', 'error', 'waiting_until'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('failed');
      expect(run.error).toContain('Answer was: ship it');
      expect(run.waiting_until).toBeNull();

      const approvalRow = await db
        .selectFrom('agent_run_steps')
        .select(['status', 'detail'])
        .where('run_id', '=', runId)
        .where('step_id', '=', approvalId)
        .executeTakeFirstOrThrow();
      expect(approvalRow.status).toBe('succeeded');
      expect(JSON.stringify(approvalRow.detail)).toContain('"decision":"approved"');
      expect(JSON.stringify(approvalRow.detail)).toContain('ship it');
    });

    it('tells the next step an ANSWER was given, not that anything was approved', async () => {
      const acting = {
        id: randomUUID(),
        name: 'Runs on the answered path',
        instruction: [{ t: 'text' as const, v: 'Use it.' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      };
      const { doc } = approvalDoc({
        mode: 'input',
        saveAs: 'the issue key',
        onApproved: [acting],
      });
      const { runId } = await seedRun(doc);
      const prompts: string[] = [];
      const llm = stubLlm((request) => {
        for (const message of request.messages) {
          for (const block of message.content) {
            if (block.type === 'text') prompts.push(block.text);
          }
        }
        return finish('success');
      });
      const handler = handlerWith(
        llm,
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });

      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({
          status: 'approved',
          result: JSON.stringify({ answer: 'CIO-12' }),
          decided_at: sql`NOW()`,
        })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      const acted = prompts.join('\n');
      // A typed string is evidence to check, never permission to act — the
      // step that reads it must be told which of the two it holds.
      expect(acted).toContain('The owner answered');
      expect(acted).not.toContain('The owner approved');
      expect(acted).toContain('the issue key');
      expect(acted).toContain('check they are usable');
      // A fact a person just supplied is the one worth keeping: the next
      // run should not have to ask the same question again.
      expect(acted).toContain('record it');
    });

    it('an input card declined reads as "no answer", not as a refusal to act', async () => {
      const acting = {
        id: randomUUID(),
        name: 'Runs on the skipped path',
        instruction: [{ t: 'text' as const, v: 'Move on.' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      };
      const { doc } = approvalDoc({
        mode: 'input',
        saveAs: 'the issue key',
        onDeclined: [acting],
      });
      const { runId } = await seedRun(doc);
      const prompts: string[] = [];
      const llm = stubLlm((request) => {
        for (const message of request.messages) {
          for (const block of message.content) {
            if (block.type === 'text') prompts.push(block.text);
          }
        }
        return finish('success');
      });
      const handler = handlerWith(
        llm,
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });

      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({ status: 'declined', decided_at: sql`NOW()` })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      const acted = prompts.join('\n');
      expect(acted).toContain('SKIPPED');
      expect(acted).toContain('Do not invent one');
    });

    it('a form card binds one variable per field, and a list for a multi-select', async () => {
      const { doc } = approvalDoc({
        mode: 'input',
        saveAs: 'what you told me',
        fields: [
          {
            name: 'the issue key',
            label: 'Which issue?',
            type: 'text',
            required: true,
          },
          {
            name: 'the comments',
            label: 'Which comments?',
            type: 'multi',
            required: false,
            options: ['decision 1', 'risk 2'],
          },
        ],
        onApproved: [
          terminalNode('failure', [
            { t: 'text', v: 'Post ' },
            { t: 'var', name: 'the comments' },
            { t: 'text', v: ' to ' },
            { t: 'var', name: 'the issue key' },
            { t: 'text', v: ' — all of it: ' },
            { t: 'var', name: 'what you told me' },
          ]),
        ],
      });
      const { runId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });

      // The card carries the form, so the feed can render controls without
      // loading the agent.
      const card = await cardOf(runId);
      expect(JSON.stringify(card.suggested_action)).toContain('Which comments?');

      await db
        .updateTable('actionable_items')
        .set({
          status: 'approved',
          result: JSON.stringify({
            answers: { 'the issue key': 'CIO-12', 'the comments': ['decision 1', 'risk 2'] },
          }),
          decided_at: sql`NOW()`,
        })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      const run = await db
        .selectFrom('agent_runs')
        .select(['status', 'error'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      // Each field bound under its OWN name; the multi-select rendered the
      // way a collected list renders.
      expect(run.error).toContain('Post decision 1\nrisk 2 to CIO-12');
      // And the whole reply under the node's own name: every label with its
      // answer, for a step that relays what was said.
      expect(run.error).toContain('Which issue?: CIO-12');
      expect(run.error).toContain('Which comments?: decision 1, risk 2');
      expect(run.status).toBe('failed');
    });

    it('a declined card routes the declined path', async () => {
      const { doc } = approvalDoc({ onDeclined: [terminalNode('stop')] });
      const { runId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });
      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({ status: 'declined', decided_at: sql`NOW()`, archived_at: sql`NOW()` })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });

      const run = await db
        .selectFrom('agent_runs')
        .select('status')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('stopped');
    });

    it('past the deadline the engine claims expiry and routes the timed-out path', async () => {
      // Empty onTimeout: the run falls through past the approval and, with
      // nothing after it, finishes.
      const { doc, approvalId } = approvalDoc({ timeoutHours: 1 });
      const { runId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });
      await db
        .updateTable('agent_runs')
        .set({ waiting_until: new Date(Date.now() - 60_000) })
        .where('id', '=', runId)
        .execute();
      await handler({ payload: { runId } });

      const run = await db
        .selectFrom('agent_runs')
        .select(['status', 'error'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('succeeded');
      expect(run.error).toBeNull();

      const card = await cardOf(runId);
      expect(card.status).toBe('expired');
      expect(card.archived_at).not.toBeNull();

      const approvalRow = await db
        .selectFrom('agent_run_steps')
        .select(['status', 'detail'])
        .where('run_id', '=', runId)
        .where('step_id', '=', approvalId)
        .executeTakeFirstOrThrow();
      expect(approvalRow.status).toBe('succeeded');
      expect(JSON.stringify(approvalRow.detail)).toContain('"decision":"expired"');
    });

    it('replays a finished approval without touching the archived card', async () => {
      const { doc } = approvalDoc({ onDeclined: [terminalNode('stop')] });
      const { runId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });
      const card = await cardOf(runId);
      await db
        .updateTable('actionable_items')
        .set({ status: 'declined', decided_at: sql`NOW()`, archived_at: sql`NOW()` })
        .where('id', '=', card.id)
        .execute();
      await handler({ payload: { runId } });
      const decidedAt = (await cardOf(runId)).decided_at;

      // Redelivery of the finished run: nothing moves.
      await handler({ payload: { runId } });
      const run = await db
        .selectFrom('agent_runs')
        .select('status')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('stopped');
      const after = await cardOf(runId);
      expect(after.status).toBe('declined');
      expect(new Date(after.decided_at ?? 0).toISOString()).toBe(
        new Date(decidedAt ?? 0).toISOString()
      );
    });

    it('disabling the agent cancels the waiting run and archives its card', async () => {
      const { doc } = approvalDoc({});
      const { runId, agentId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });
      await db.updateTable('agents').set({ enabled: false }).where('id', '=', agentId).execute();
      await handler({ payload: { runId } });

      const run = await db
        .selectFrom('agent_runs')
        .select(['status', 'waiting_until'])
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe('canceled');
      expect(run.waiting_until).toBeNull();
      const card = await cardOf(runId);
      expect(card.status).toBe('expired');
      expect(JSON.stringify(card.result)).toContain('agent-disabled');
    });

    it('the sweep expires due waits, re-enqueues them, and clears cards of dead runs', async () => {
      const { doc } = approvalDoc({ timeoutHours: 1 });
      const { runId, agentId } = await seedRun(doc);
      const handler = handlerWith(
        noModel(),
        stubMcp([], () => okToolResult)
      );
      await handler({ payload: { runId } });
      await db
        .updateTable('agent_runs')
        .set({ waiting_until: new Date(Date.now() - 60_000) })
        .where('id', '=', runId)
        .execute();

      // A second, already-finished run whose card was never resolved — the
      // mirror-orphan arm must clear it WITHOUT enqueueing anything.
      const { runId: deadRunId } = await seedRun(approvalDoc({}).doc);
      await handler({ payload: { runId: deadRunId } });
      await db
        .updateTable('agent_runs')
        .set({ status: 'canceled', waiting_until: null, finished_at: sql`NOW()` })
        .where('id', '=', deadRunId)
        .execute();

      const enqueued: QueueMessageInput[] = [];
      const sweep = createApprovalSweep(db, {
        enqueue: async (message) => {
          enqueued.push(message);
          return ok(undefined);
        },
      });
      await sweep();

      const card = await cardOf(runId);
      expect(card.status).toBe('expired');
      expect(JSON.stringify(card.result)).toContain('timeout');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({
        payload: { runId },
        orderingKey: `agent:${agentId}`,
      });

      const deadCard = await cardOf(deadRunId);
      expect(deadCard.status).toBe('expired');
      expect(JSON.stringify(deadCard.result)).toContain('run-ended');
    });
  });
});

maybe('resolve_time — the free, deterministic clock', () => {
  jest.setTimeout(20_000);
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `test-subject-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `rt-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('identities')
      .values({ tenant_id: tenantId, subject, email: 'owner@example.com', display_name: 'Owner' })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM agent_run_steps WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM identities WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    // This suite reopened the pool the previous one closed; leave it shut so
    // the worker process exits instead of hanging on an idle connection.
    await closeDatabase();
  });

  async function seedOneStep(): Promise<string> {
    const agentId = randomUUID();
    const doc: AgentStepsDoc = {
      version: 1,
      steps: [
        {
          id: randomUUID(),
          name: 'Search yesterday evening',
          instruction: [{ t: 'text', v: 'Search mail from yesterday 19:00 Los Angeles.' }],
          tool: 'jira_get_issue',
          maxAttempts: 1,
          failureHandling: [],
        },
      ],
    };
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: subject,
        name: `agent-${agentId.slice(0, 8)}`,
        steps: JSON.stringify(doc),
        enabled: true,
      })
      .execute();
    const runId = randomUUID();
    await db
      .insertInto('agent_runs')
      .values({
        id: runId,
        tenant_id: tenantId,
        agent_id: agentId,
        owner_subject: subject,
        trigger_kind: 'manual',
        steps_snapshot: JSON.stringify(doc),
        lineage: JSON.stringify([]),
        status: 'queued',
      })
      .execute();
    return runId;
  }

  it('answers in-process, costs no budget, and still leaves the step its own tool', async () => {
    const runId = await seedOneStep();
    const seen: string[] = [];
    let mcpCalls = 0;
    // Four resolve_time calls — well past the 3-call budget — then the
    // step's real tool, then finish. If resolve_time were billed, the real
    // call would be refused.
    const llm = stubLlm((request, call) => {
      for (const message of request.messages) {
        for (const block of message.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            seen.push(block.content);
          }
        }
      }
      if (call < 4) {
        return useTool('resolve_time', {
          timezone: 'America/Los_Angeles',
          amount: -1,
          unit: 'day',
          atTime: '19:00',
        });
      }
      if (call === 4) return useTool('jira_get_issue', { issueKey: 'PROJ-42' });
      return finish('success', { saveValue: 'done' });
    });
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () =>
        stubMcp(['jira_get_issue'], () => {
          mcpCalls += 1;
          return okToolResult;
        }),
      resolveLlm: async () => ok(llm),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
    });
    await handler({ payload: { runId } });

    const run = await db
      .selectFrom('agent_runs')
      .select(['status', 'error'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');

    // The real tool ran despite four prior date calls — that is "free".
    expect(mcpCalls).toBe(1);
    // The clock answered locally: an ISO instant, never routed through MCP.
    const answered = seen.filter((text) => text.includes('"iso"'));
    expect(answered.length).toBeGreaterThanOrEqual(1);
    expect(answered[0]).toContain('America/Los_Angeles');

    // Only the billed call is counted, though the timeline keeps both.
    const attempt = await db
      .selectFrom('agent_run_steps')
      .select(['tool_call_count', 'detail'])
      .where('run_id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(attempt.tool_call_count).toBe(1);
    expect(JSON.stringify(attempt.detail)).toContain('resolve_time');
  });

  it('hands a bad timezone straight back instead of guessing', async () => {
    const runId = await seedOneStep();
    const seen: string[] = [];
    const llm = stubLlm((request, call) => {
      for (const message of request.messages) {
        for (const block of message.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            seen.push(block.content);
          }
        }
      }
      if (call === 0) return useTool('resolve_time', { timezone: 'Pacific Time' });
      return finish('success');
    });
    const handler = createAgentRunHandler({
      db,
      webBaseUrl: 'http://unused.example',
      createMcpClient: () => stubMcp(['jira_get_issue'], () => okToolResult),
      resolveLlm: async () => ok(llm),
      mintToken: async () => 'stub-token',
      revokeToken: async () => undefined,
    });
    await handler({ payload: { runId } });

    const complaint = seen.find((text) => text.includes('IANA'));
    expect(complaint).toBeDefined();
    // And it says the retry is free, so the model re-asks rather than guesses.
    expect(complaint).toContain('it is free');
  });
});
