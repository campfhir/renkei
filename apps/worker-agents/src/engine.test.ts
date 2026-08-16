/**
 * The engine against a real database (skipped without DATABASE_URL) and a
 * scripted model/MCP pair. What must hold: a run executes its snapshot and
 * records every attempt; a declared success stands; a retry path consumes
 * the step's TOTAL attempt budget and never exceeds the platform's 5; a
 * failure with an 'exit' handling stops the run; redelivering a terminal
 * run is a no-op.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { closeDatabase, getDatabase } from '@renkei/db';
import { ok } from '@campfhir/safe-functions/helpers';
import type { LlmRequest, LlmResponse, ResolvedLlm } from '@renkei/agent-llm';
import type { AgentStepsDoc } from '@renkei/agents';
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
  outcome: 'success' | 'failure',
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

  const db = (() => {
    const result = getDatabase();
    if (!result.ok) throw new Error('database unavailable');
    return result.val;
  })();

  const tenantId = randomUUID();
  const subject = `test-subject-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
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
    expect(attempts).toHaveLength(5);
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
});
