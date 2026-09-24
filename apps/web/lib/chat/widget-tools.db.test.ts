/**
 * recordWidgetModelContext against a real database (skipped without
 * DATABASE_URL and TOKEN_ENCRYPTION_KEY): a preview card's decision is a
 * note row that opens a turn of its own — the model's cue to reply — a
 * running turn refuses it, and a chat with no usable model keeps the
 * note on its own, with no turn. The turn's model work is captured
 * through `defer` and never run: what is under test is the rows.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { encrypt, parseEncryptionKey } from '@renkei/crypto';
import { recordWidgetModelContext } from './widget-tools';

const maybe =
  process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? describe : describe.skip;

maybe('recordWidgetModelContext', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  /** A tenant with no model configured at all. */
  const modellessTenantId = randomUUID();
  const me = `me-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const modellessChatId = randomUUID();
  const modelId = randomUUID();
  const session: { subject: string; roles: string[] } = { subject: me, roles: [] };
  const deferred: Array<() => Promise<void>> = [];
  const defer = (task: () => Promise<void>) => {
    deferred.push(task);
  };
  const DECISION =
    'The user confirmed "Create Jira issue" on the preview card. Result: Created issue OPS-1.';

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY ?? '');
    if (!key.ok) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
    await db
      .insertInto('tenants')
      .values([
        { id: tenantId, slug: tenantId },
        { id: modellessTenantId, slug: modellessTenantId },
      ])
      .execute();
    await db
      .insertInto('llm_model_configs')
      .values({
        id: modelId,
        tenant_id: tenantId,
        label: 'Card model',
        provider: 'anthropic',
        model: 'e2e-model',
        encrypted_secrets: encrypt(JSON.stringify({ apiKey: 'test' }), key.val),
        enabled: true,
        is_default: true,
      })
      .execute();
    await db
      .insertInto('chats')
      .values([
        { id: chatId, tenant_id: tenantId, owner_subject: me, title: 'Rotate the secret' },
        {
          id: modellessChatId,
          tenant_id: modellessTenantId,
          owner_subject: me,
          title: 'No model here',
        },
      ])
      .execute();
  });

  afterAll(async () => {
    for (const tenant of [tenantId, modellessTenantId]) {
      await sql`DELETE FROM chat_messages WHERE tenant_id = ${tenant}`.execute(db);
      await sql`DELETE FROM chat_turns WHERE tenant_id = ${tenant}`.execute(db);
      await sql`DELETE FROM chats WHERE tenant_id = ${tenant}`.execute(db);
      await sql`DELETE FROM llm_model_configs WHERE tenant_id = ${tenant}`.execute(db);
      await sql`DELETE FROM tenants WHERE id = ${tenant}`.execute(db);
    }
    await closeDatabase();
  });

  it('records the decision as a note row that opens a turn of its own', async () => {
    const recorded = await recordWidgetModelContext(db, {
      tenantId,
      session,
      chatId,
      text: DECISION,
      defer,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).not.toBeNull();
    expect(recorded.message.kind).toBe('note');
    expect(recorded.message.turnId).toBe(recorded.turn?.turnId ?? null);
    expect(recorded.message.blocks).toEqual([{ type: 'text', text: DECISION }]);
    // The model work was handed off, not run here.
    expect(deferred).toHaveLength(1);

    const turn = await db
      .selectFrom('chat_turns')
      .select(['status', 'kind'])
      .where('id', '=', recorded.turn?.turnId ?? '')
      .executeTakeFirst();
    expect(turn).toEqual({ status: 'running', kind: 'reply' });
    const rows = await db
      .selectFrom('chat_messages')
      .select(['role', 'kind', 'status', 'turn_id'])
      .where('chat_id', '=', chatId)
      .orderBy('seq')
      .execute();
    expect(rows).toEqual([
      { role: 'user', kind: 'note', status: 'complete', turn_id: recorded.turn?.turnId },
      { role: 'assistant', kind: 'assistant', status: 'streaming', turn_id: recorded.turn?.turnId },
    ]);
  });

  it('refuses while that turn is still running, writing nothing', async () => {
    const recorded = await recordWidgetModelContext(db, {
      tenantId,
      session,
      chatId,
      text: 'The user cancelled "Create Jira issue" from the preview card. Nothing was written.',
      defer,
    });
    expect(recorded).toEqual({ ok: false, reason: 'turn-running' });
    const notes = await db
      .selectFrom('chat_messages')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('chat_id', '=', chatId)
      .where('kind', '=', 'note')
      .executeTakeFirstOrThrow();
    expect(Number(notes.n)).toBe(1);
    expect(deferred).toHaveLength(1);
  });

  it('keeps the note without a turn when the chat has no usable model', async () => {
    const recorded = await recordWidgetModelContext(db, {
      tenantId: modellessTenantId,
      session,
      chatId: modellessChatId,
      text: DECISION,
      defer,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).toBeNull();
    expect(recorded.message.kind).toBe('note');
    expect(recorded.message.turnId).toBeNull();
    const rows = await db
      .selectFrom('chat_messages')
      .select(['role', 'kind', 'turn_id'])
      .where('chat_id', '=', modellessChatId)
      .execute();
    expect(rows).toEqual([{ role: 'user', kind: 'note', turn_id: null }]);
    const turns = await db
      .selectFrom('chat_turns')
      .select('id')
      .where('chat_id', '=', modellessChatId)
      .execute();
    expect(turns).toEqual([]);
    expect(deferred).toHaveLength(1);
  });
});
