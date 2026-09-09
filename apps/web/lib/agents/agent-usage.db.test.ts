/**
 * The per-model and per-step token reads against a real database
 * (skipped without DATABASE_URL), end to end from `recordLlmCall` — the
 * grouped SQL with its conditional agent filter is the part a unit test
 * cannot see.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { CURRENT_STEPS_VERSION } from '@renkei/agents';
import { recordLlmCall } from '@renkei/agents/runs';
import { getAgentTokenUsageByStep, getTokenUsageByModel } from './agent-usage';
import { labelStepUsage } from './step-usage-labels';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('token usage by model and by step', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const stepId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const steps = {
    version: CURRENT_STEPS_VERSION,
    steps: [
      {
        id: stepId,
        name: 'Read the inbox',
        instruction: [{ t: 'text', v: 'Look.' }],
        tool: null,
        maxAttempts: 1,
        failureHandling: [],
      },
    ],
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `usage-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('agents')
      .values({
        id: agentId,
        tenant_id: tenantId,
        owner_subject: subject,
        name: 'Usage agent',
        steps: JSON.stringify(steps),
        enabled: true,
      })
      .execute();

    const big = { provider: 'anthropic', model: 'claude-big', llmModelId: null };
    const small = { provider: 'openai', model: 'gpt-small', llmModelId: null };
    const base = { tenantId, subject, agentId, runId: randomUUID(), stepId };
    await recordLlmCall(db, {
      ...base,
      purpose: 'run',
      inputTokens: 100,
      outputTokens: 10,
      model: big,
    });
    await recordLlmCall(db, {
      ...base,
      purpose: 'run',
      inputTokens: 200,
      outputTokens: 20,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 40,
      model: big,
    });
    await recordLlmCall(db, {
      tenantId,
      subject,
      agentId,
      purpose: 'optimize',
      inputTokens: 1_000,
      outputTokens: 50,
      model: small,
    });
    // A chat turn: the person's own spend, no agent.
    await recordLlmCall(db, {
      tenantId,
      subject,
      agentId: null,
      purpose: 'chat',
      inputTokens: 5_000,
      outputTokens: 500,
      model: big,
    });
    // A row from before the model was recorded.
    await recordLlmCall(db, { ...base, purpose: 'run', inputTokens: 7, outputTokens: 3 });
  });

  afterAll(async () => {
    await sql`DELETE FROM llm_calls WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM agents WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('splits the whole org by model, chat and optimizer spend included', async () => {
    const rows = await getTokenUsageByModel(db, tenantId, null);
    expect(
      rows.map((row) => [
        row.provider,
        row.model,
        row.input.today,
        row.output.today,
        row.cacheRead.today,
        row.cacheWrite.today,
      ])
    ).toEqual([
      ['anthropic', 'claude-big', 5_300, 530, 900, 40],
      ['openai', 'gpt-small', 1_000, 50, 0, 0],
      [null, null, 7, 3, 0, 0],
    ]);
  });

  it('narrows to one agent, leaving the chat out', async () => {
    const rows = await getTokenUsageByModel(db, tenantId, agentId);
    expect(rows.map((row) => [row.model, row.input.allTime])).toEqual([
      ['gpt-small', 1_000],
      ['claude-big', 300],
      [null, 7],
    ]);
    expect(await getTokenUsageByModel(db, tenantId, [])).toEqual([]);
  });

  it('splits one agent by step and model, named from its definition', async () => {
    const rows = labelStepUsage(steps, await getAgentTokenUsageByStep(db, tenantId, agentId));
    expect(
      rows.map((row) => [
        row.stepName,
        row.model,
        row.calls.today,
        row.input.today,
        row.cacheRead.today,
        row.output.today,
      ])
    ).toEqual([
      [null, 'gpt-small', 1, 1_000, 0, 50],
      ['Read the inbox', 'claude-big', 2, 300, 900, 30],
      ['Read the inbox', null, 1, 7, 0, 3],
    ]);
    expect(rows[0].stepId).toBeNull();
  });
});
