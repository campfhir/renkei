/**
 * A chat's key through the chat's own doors, against a real database
 * (skipped without DATABASE_URL): a new chat is born with a key, its
 * owner's rows go under it, sharing lets the grantee open exactly those
 * rows, revoking shuts them out again, a legacy chat's rows stay readable
 * and its first owner write mints a key wrapped for its existing viewers,
 * and deleting the chat takes the key with it.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { isResourceEncrypted, isEncryptedContent } from '@renkei/crypto';
import { listResourceKeyHolders, openResourceKey } from '@renkei/user-keys';
import { grantResourceAccess, resolveChatAccess, revokeResourceGrant } from './access';
import { chatCiphersFor, revokeChatKey, shareChatKey } from './chat-keys';
import { legacyCipher, sealBlocks } from './content-crypto';
import { insertMessage, listMessages } from './messages';
import { createChat, deleteChat, getChatRow } from './store';
import { searchChatMessages } from './search';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat keys through the chat', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const friend = `friend-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;
  let chatId: string;

  const ref = (id: string) => ({ tenantId, kind: 'chat' as const, resourceId: id });
  const rawContent = async (id: string) =>
    (
      await db
        .selectFrom('chat_messages')
        .select('content')
        .where('chat_id', '=', id)
        .orderBy('seq', 'asc')
        .execute()
    ).map((row) => row.content);
  const texts = (rows: Awaited<ReturnType<typeof listMessages>>) =>
    rows.map((row) => row.blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(''));

  beforeAll(async () => {
    process.env.CONTENT_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `chatkeys-${tenantId.slice(0, 8)}` })
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('a new chat has a key, and its owner writes under it', async () => {
    chatId = await createChat(db, {
      tenantId,
      ownerSubject: owner,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
    });
    expect((await openResourceKey(db, ref(chatId), owner)).ok).toBe(true);

    const access = await resolveChatAccess(db, tenantId, owner, chatId);
    expect(access?.role).toBe('owner');
    if (!access) return;
    expect(access.cipher.keyId).not.toBeNull();
    const inserted = await insertMessage(db, {
      tenantId,
      chatId,
      turnId: null,
      role: 'user',
      kind: 'prompt',
      status: 'complete',
      blocks: [{ type: 'text', text: 'the quarterly numbers' }],
      cipher: access.cipher,
    });
    expect(inserted).not.toBeNull();
    const [stored] = await rawContent(chatId);
    expect(isResourceEncrypted(stored)).toBe(true);
    expect(stored).toContain(`renc2:${access.cipher.keyId}:`);
    expect(texts(await listMessages(db, tenantId, chatId, access.cipher))).toEqual([
      'the quarterly numbers',
    ]);
    // Without the key, the row is a marker — never the bytes, never a 500.
    expect(texts(await listMessages(db, tenantId, chatId, legacyCipher))[0]).toContain(
      'content unavailable'
    );
  });

  it('nobody but the owner resolves access, so nobody else gets a cipher', async () => {
    expect(await resolveChatAccess(db, tenantId, friend, chatId)).toBeNull();
    expect((await openResourceKey(db, ref(chatId), friend)).ok).toBe(false);
  });

  it('sharing rewraps the key for the grantee, who then reads the rows', async () => {
    const granted = await grantResourceAccess(db, tenantId, owner, 'chat', chatId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });
    expect(granted).toBe('OK');
    expect(await shareChatKey(db, tenantId, chatId, owner, friend)).toBe(true);
    expect((await listResourceKeyHolders(db, ref(chatId))).map((h) => h.subject).sort()).toEqual(
      [friend, owner].sort()
    );

    const access = await resolveChatAccess(db, tenantId, friend, chatId);
    expect(access?.role).toBe('viewer');
    expect(access?.via).toBe('grant');
    if (!access) return;
    expect(texts(await listMessages(db, tenantId, chatId, access.cipher))).toEqual([
      'the quarterly numbers',
    ]);
    // The content itself did not move: still one row, under the one key.
    const [stored] = await rawContent(chatId);
    expect(stored).toContain(`renc2:${access.cipher.keyId}:`);
  });

  it('a grant whose rewrap never landed is healed on the grantee’s first read', async () => {
    await grantResourceAccess(db, tenantId, owner, 'chat', chatId, {
      granteeSubject: stranger,
      role: 'viewer',
      expiresAt: null,
    });
    // No shareChatKey: the access row exists, the wrapping does not.
    expect((await openResourceKey(db, ref(chatId), stranger)).ok).toBe(false);
    const access = await resolveChatAccess(db, tenantId, stranger, chatId);
    expect(access?.via).toBe('grant');
    if (!access) return;
    expect(texts(await listMessages(db, tenantId, chatId, access.cipher))).toEqual([
      'the quarterly numbers',
    ]);
    expect((await openResourceKey(db, ref(chatId), stranger)).ok).toBe(true);
  });

  it('revoking the share forgets the wrapping; the owner is untouched', async () => {
    const grant = await db
      .selectFrom('resource_access_grants')
      .select('id')
      .where('resource_id', '=', chatId)
      .where('grantee_subject', '=', friend)
      .executeTakeFirstOrThrow();
    const revoked = await revokeResourceGrant(db, tenantId, owner, 'chat', chatId, grant.id);
    expect(revoked).toBe(friend);
    await revokeChatKey(db, tenantId, chatId, friend);
    expect((await openResourceKey(db, ref(chatId), friend)).ok).toBe(false);
    expect(await resolveChatAccess(db, tenantId, friend, chatId)).toBeNull();
    expect((await openResourceKey(db, ref(chatId), owner)).ok).toBe(true);
  });

  it('a legacy chat reads, and the owner’s first write mints a key wrapped for its viewers', async () => {
    // A chat from before keys: inserted directly, rows under the deployment key.
    const legacyId = randomUUID();
    await db
      .insertInto('chats')
      .values({ id: legacyId, tenant_id: tenantId, owner_subject: owner })
      .execute();
    const sealed = sealBlocks([{ type: 'text', text: 'from before keys' }]);
    if (!sealed.ok) throw new Error('no content key');
    await db
      .insertInto('chat_messages')
      .values({
        tenant_id: tenantId,
        chat_id: legacyId,
        turn_id: null,
        seq: 1,
        role: 'user',
        kind: 'prompt',
        content: sealed.val,
      })
      .execute();
    await grantResourceAccess(db, tenantId, owner, 'chat', legacyId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });

    // The viewer, before any owner act: the legacy cipher, and the row reads.
    const asViewer = await resolveChatAccess(db, tenantId, friend, legacyId);
    expect(asViewer?.cipher.keyId).toBeNull();
    if (!asViewer) return;
    expect(texts(await listMessages(db, tenantId, legacyId, asViewer.cipher))).toEqual([
      'from before keys',
    ]);

    // The owner's access mints the key — wrapped for the existing viewer too.
    const asOwner = await resolveChatAccess(db, tenantId, owner, legacyId);
    expect(asOwner?.cipher.keyId).not.toBeNull();
    if (!asOwner) return;
    expect((await listResourceKeyHolders(db, ref(legacyId))).map((h) => h.subject).sort()).toEqual(
      [friend, owner].sort()
    );
    await insertMessage(db, {
      tenantId,
      chatId: legacyId,
      turnId: null,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      blocks: [{ type: 'text', text: 'after keys' }],
      cipher: asOwner.cipher,
    });
    const [first, second] = await rawContent(legacyId);
    expect(isEncryptedContent(first)).toBe(true);
    expect(isResourceEncrypted(second)).toBe(true);
    // Both open, for the owner and for the viewer, old row and new alike.
    expect(texts(await listMessages(db, tenantId, legacyId, asOwner.cipher))).toEqual([
      'from before keys',
      'after keys',
    ]);
    const viewerNow = await resolveChatAccess(db, tenantId, friend, legacyId);
    if (!viewerNow) throw new Error('viewer lost access');
    expect(texts(await listMessages(db, tenantId, legacyId, viewerNow.cipher))).toEqual([
      'from before keys',
      'after keys',
    ]);

    // Search opens each chat with the viewer's own cipher.
    const chats = [
      await getChatRow(db, tenantId, chatId),
      await getChatRow(db, tenantId, legacyId),
    ].flatMap((chat) => (chat ? [chat] : []));
    const ciphers = await chatCiphersFor(db, tenantId, friend, chats);
    const hits = await searchChatMessages(db, tenantId, [chatId, legacyId], 'after keys', ciphers);
    expect(hits.map((hit) => hit.chatId)).toEqual([legacyId]);
  });

  it('deleting the chat deletes its key', async () => {
    expect(await deleteChat(db, tenantId, owner, chatId)).toBe(true);
    expect(await openResourceKey(db, ref(chatId), owner)).toMatchObject({
      ok: false,
      err: { type: 'NO_KEY' },
    });
  });
});
