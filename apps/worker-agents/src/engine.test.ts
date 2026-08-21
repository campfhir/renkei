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
import { isAgentStepsDoc, type AgentStepsDoc } from '@renkei/agents';
import { createAgentRunHandler } from './engine';
import type { McpClient, McpToolResult } from './mcp-client';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

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
  outcome: 'success' | 'failure' | 'nothing-to-do',
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
    // inside a nothing-to-do run, and not admin-visible content either
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

  it('ends the run as stopped — not failed — when finish_step declares nothing-to-do', async () => {
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
      resolveLlm: async () => ok(stubLlm(() => finish('nothing-to-do'))),
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
    expect(JSON.stringify(attempts[0].detail)).toContain('nothing-to-do');

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
    const { runId } = await seedRun(
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
      const forced =
        typeof request.toolChoice === 'object' && request.toolChoice?.name === 'choose_path';
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
});
