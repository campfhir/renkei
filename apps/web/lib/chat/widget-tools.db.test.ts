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
import {
  getWidgetDecision,
  listWidgetDecisions,
  recordWidgetModelContext,
  recordWidgetDecision,
} from './widget-tools';
import { insertMessage } from './messages';
import { legacyCipher } from './content-crypto';

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

/**
 * A card's decision, durable across devices (chat_widget_decisions): the
 * write path a card's Confirm or Cancel reports through (widget-tools.ts's
 * `recordWidgetDecision`), and the two read paths that keep a second device
 * from re-showing live buttons — `getWidgetDecision` (confirmWidgetTool's
 * own guard against running a confirm tool twice) and `listWidgetDecisions`
 * (chat-view.ts's batch read for one chat's whole message list).
 */
maybe('chat widget decisions', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const me = `me-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const otherChatId = randomUUID();
  const stateKey = `renkei-preview:${randomUUID()}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db.insertInto('tenants').values({ id: tenantId, slug: tenantId }).execute();
    await db
      .insertInto('chats')
      .values([
        { id: chatId, tenant_id: tenantId, owner_subject: me, title: 'Rotate the secret' },
        { id: otherChatId, tenant_id: tenantId, owner_subject: me, title: 'A different chat' },
      ])
      .execute();
  });

  afterAll(async () => {
    await sql`DELETE FROM chat_widget_decisions WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chats WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('is absent until recorded', async () => {
    expect(await getWidgetDecision(db, tenantId, stateKey)).toBeNull();
    expect(await listWidgetDecisions(db, tenantId, chatId)).toEqual(new Map());
  });

  it('records a decision, readable by its own key and by its chat', async () => {
    const recorded = await recordWidgetDecision(db, {
      tenantId,
      chatId,
      subject: me,
      stateKey,
      decision: 'confirmed',
      state: {
        icon: 'sent',
        headline: 'Created issue OPS-1.',
        detail: 'OPS · Task',
        links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-1' }],
      },
    });
    expect(recorded).toEqual({ ok: true });

    expect(await getWidgetDecision(db, tenantId, stateKey)).toEqual({
      icon: 'sent',
      headline: 'Created issue OPS-1.',
      detail: 'OPS · Task',
      links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-1' }],
    });
    expect(await listWidgetDecisions(db, tenantId, chatId)).toEqual(
      new Map([
        [
          stateKey,
          {
            icon: 'sent',
            headline: 'Created issue OPS-1.',
            detail: 'OPS · Task',
            links: [{ label: 'Open in Jira', href: 'https://example.atlassian.net/browse/OPS-1' }],
          },
        ],
      ])
    );
    // A different chat in the same tenant never sees another chat's card.
    expect(await listWidgetDecisions(db, tenantId, otherChatId)).toEqual(new Map());
  });

  it('keeps the first decision when a second is reported for the same key', async () => {
    // A race between two devices, or a retry — by the time a second report
    // for one state_key could arrive, whatever it reported already
    // happened once (a tool call, or nothing, for Cancel); recording a
    // later, different report over it would rewrite that history.
    const recorded = await recordWidgetDecision(db, {
      tenantId,
      chatId,
      subject: me,
      stateKey,
      decision: 'cancelled',
      state: { icon: 'cancelled', headline: 'Cancelled' },
    });
    expect(recorded).toEqual({ ok: true });
    expect(await getWidgetDecision(db, tenantId, stateKey)).toMatchObject({
      icon: 'sent',
      headline: 'Created issue OPS-1.',
    });
  });
});

/**
 * One reply presenting two cards at once: deciding the first must not open
 * a turn while the second is still undecided (the model would answer
 * having seen only one of them), and deciding the second — now that both
 * have a recorded decision — opens exactly one turn, informed by both.
 */
maybe('recordWidgetModelContext: batches decisions from one reply', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const me = `me-${tenantId.slice(0, 8)}`;
  const chatId = randomUUID();
  const modelId = randomUUID();
  const replyTurnId = randomUUID();
  const toolUseIdA = `toolu_${randomUUID()}`;
  const toolUseIdB = `toolu_${randomUUID()}`;
  const stateKeyA = `renkei-preview:${randomUUID()}`;
  const stateKeyB = `renkei-preview:${randomUUID()}`;
  const session: { subject: string; roles: string[] } = { subject: me, roles: [] };
  const deferred: Array<() => Promise<void>> = [];
  const defer = (task: () => Promise<void>) => {
    deferred.push(task);
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY ?? '');
    if (!key.ok) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
    await db.insertInto('tenants').values({ id: tenantId, slug: tenantId }).execute();
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
      .values({ id: chatId, tenant_id: tenantId, owner_subject: me, title: 'Two cards at once' })
      .execute();
    // The reply that presented both cards — already finished, so a new
    // turn is free to start once both are decided.
    await db
      .insertInto('chat_turns')
      .values({
        id: replyTurnId,
        tenant_id: tenantId,
        chat_id: chatId,
        status: 'completed',
        llm_model_id: modelId,
        iterations: 1,
        finished_at: new Date(),
      })
      .execute();
    await insertMessage(db, {
      tenantId,
      chatId,
      turnId: replyTurnId,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      cipher: legacyCipher,
      blocks: [
        { type: 'text', text: 'Two role assignments to review.' },
        { type: 'tool_use', id: toolUseIdA, name: 'entra_assign_app_role_preview', input: {} },
        { type: 'tool_use', id: toolUseIdB, name: 'entra_assign_app_role_preview', input: {} },
      ],
    });
    await insertMessage(db, {
      tenantId,
      chatId,
      turnId: replyTurnId,
      role: 'user',
      kind: 'tool_results',
      status: 'complete',
      cipher: legacyCipher,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: toolUseIdA,
          content: 'Awaiting the user’s decision on the preview card.',
          uiResourceUri: 'ui://widget/directory-action-preview.test.html',
          structuredContent: { kind: 'directory_action', previewId: stateKeyA.split(':')[1] },
        },
        {
          type: 'tool_result',
          toolUseId: toolUseIdB,
          content: 'Awaiting the user’s decision on the preview card.',
          uiResourceUri: 'ui://widget/directory-action-preview.test.html',
          structuredContent: { kind: 'directory_action', previewId: stateKeyB.split(':')[1] },
        },
      ],
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM chat_widget_decisions WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chat_messages WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chat_turns WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chats WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM llm_model_configs WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('appends the first decision as a note, opening no turn, while its sibling is undecided', async () => {
    await recordWidgetDecision(db, {
      tenantId,
      chatId,
      subject: me,
      stateKey: stateKeyA,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Assigned Tony Liang.' },
    });
    const recorded = await recordWidgetModelContext(db, {
      tenantId,
      session,
      chatId,
      text: 'The user confirmed "Assign app role" (Tony Liang) on the preview card.',
      stateKey: stateKeyA,
      defer,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).toBeNull();
    expect(recorded.message.turnId).toBeNull();
    expect(deferred).toHaveLength(0);

    const turns = await db
      .selectFrom('chat_turns')
      .select('id')
      .where('chat_id', '=', chatId)
      .execute();
    // Still just the one (already-finished) reply turn — none opened yet.
    expect(turns).toEqual([{ id: replyTurnId }]);
  });

  it('opens exactly one turn once the second decision lands, informed by both', async () => {
    await recordWidgetDecision(db, {
      tenantId,
      chatId,
      subject: me,
      stateKey: stateKeyB,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Assigned Rachel Cheng.' },
    });
    const recorded = await recordWidgetModelContext(db, {
      tenantId,
      session,
      chatId,
      text: 'The user confirmed "Assign app role" (Rachel Cheng) on the preview card.',
      stateKey: stateKeyB,
      defer,
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.turn).not.toBeNull();
    expect(recorded.message.turnId).toBe(recorded.turn?.turnId ?? null);
    // The model work for THIS turn was handed off, not run.
    expect(deferred).toHaveLength(1);

    const turns = await db
      .selectFrom('chat_turns')
      .select('id')
      .where('chat_id', '=', chatId)
      .execute();
    // Exactly one NEW turn opened across both decisions, not one each.
    expect(turns).toEqual(
      expect.arrayContaining([{ id: replyTurnId }, { id: recorded.turn?.turnId }])
    );
    expect(turns).toHaveLength(2);

    const noteRows = await db
      .selectFrom('chat_messages')
      .select(['kind', 'turn_id'])
      .where('chat_id', '=', chatId)
      .where('kind', '=', 'note')
      .orderBy('seq')
      .execute();
    expect(noteRows).toEqual([
      { kind: 'note', turn_id: null },
      { kind: 'note', turn_id: recorded.turn?.turnId },
    ]);
  });
});
