/**
 * A sub-agent's run against a real database (skipped without
 * DATABASE_URL): the model it ran on (migration 118) is kept with the run
 * and read back with the config's label as it is today — and stands on
 * its name columns alone once that config is gone. Content sealing is
 * stood in for: no content key here, and the envelope is the crypto
 * package's concern.
 */

jest.mock('./content-crypto', () => ({
  ...jest.requireActual<typeof import('./content-crypto')>('./content-crypto'),
  sealText: (text: string) => ({ ok: true, val: text }),
  openText: (stored: string) => stored,
}));

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { createSubagentRun, finishSubagentRun, getSubagentRunByCall } from './subagent-runs';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat_subagent_runs model', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const turnId = randomUUID();
  const fastModelId = randomUUID();

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `subagent-${tenantId.slice(0, 8)}` })
      .execute();
    await db
      .insertInto('chats')
      .values({ id: chatId, tenant_id: tenantId, owner_subject: subject })
      .execute();
    await db
      .insertInto('chat_turns')
      .values({ id: turnId, tenant_id: tenantId, chat_id: chatId, status: 'running' })
      .execute();
    await db
      .insertInto('llm_model_configs')
      .values({
        id: fastModelId,
        tenant_id: tenantId,
        label: 'Fast model',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        encrypted_secrets: 'sealed',
        enabled: true,
        is_default: false,
      })
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM chat_subagent_runs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chat_turns WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chats WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM llm_model_configs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('keeps the model a run started on and reads it back with its label, then without', async () => {
    const runId = await createSubagentRun(db, {
      tenantId,
      chatId,
      turnId,
      toolUseId: 'toolu_fast',
      task: 'Find every caller of foo',
      instructions: null,
      readOnly: true,
      maxSteps: 10,
      model: { provider: 'anthropic', model: 'claude-haiku-4-5', llmModelId: fastModelId },
    });
    expect(runId).not.toBeNull();
    await finishSubagentRun(db, runId!, {
      status: 'completed',
      transcript: [],
      report: 'three callers',
      error: null,
      steps: 2,
      toolCalls: 3,
    });
    const run = await getSubagentRunByCall(db, tenantId, chatId, 'toolu_fast');
    expect(run?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      label: 'Fast model',
    });

    // The config removed: the run still says what answered, by name.
    await sql`DELETE FROM llm_model_configs WHERE id = ${fastModelId}`.execute(db);
    const later = await getSubagentRunByCall(db, tenantId, chatId, 'toolu_fast');
    expect(later?.model).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5', label: null });
  });

  it('records no model for a run started without one, as before the column existed', async () => {
    const runId = await createSubagentRun(db, {
      tenantId,
      chatId,
      turnId,
      toolUseId: 'toolu_plain',
      task: 'do it',
      instructions: null,
      readOnly: false,
      maxSteps: 10,
      model: null,
    });
    expect(runId).not.toBeNull();
    const run = await getSubagentRunByCall(db, tenantId, chatId, 'toolu_plain');
    expect(run?.model).toBeNull();
  });
});
