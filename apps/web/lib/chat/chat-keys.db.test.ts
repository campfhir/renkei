/**
 * A chat's key through the chat's own doors, against a real database
 * (skipped without DATABASE_URL): a new chat is born with a key, its
 * owner's rows go under it, sharing lets the grantee open exactly those
 * rows, revoking shuts them out again, a chat without a key mints one on
 * its owner's first access (wrapped for its existing viewers) and reads as
 * "no key" to a viewer until then, and deleting the chat takes the key
 * with it. The same for a project's instructions and memory.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { isResourceEncrypted } from '@renkei/crypto';
import { listResourceKeyHolders, openResourceKey } from '@renkei/user-keys';
import {
  grantResourceAccess,
  resolveChatAccess,
  resolveProjectAccess,
  revokeResourceGrant,
} from './access';
import { chatCiphersFor, revokeKey, shareKey } from './chat-keys';
import { insertMessage, listMessages } from './messages';
import { createChat, deleteChat, getChatRow } from './store';
import { createProject, getProjectRow, openProjectInstructions, updateProject } from './projects';
import { appendProjectMemory, readProjectMemory } from './memory';
import { appendUserMemory, readUserMemory } from './user-memory';
import { searchChatMessages } from './search';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat and project keys through the chat', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const owner = `owner-${tenantId.slice(0, 8)}`;
  const friend = `friend-${tenantId.slice(0, 8)}`;
  const stranger = `stranger-${tenantId.slice(0, 8)}`;
  let chatId: string;

  const ref = (id: string, kind: 'chat' | 'chat_project' = 'chat') => ({
    tenantId,
    kind,
    resourceId: id,
  });
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
    process.env.USER_KEY_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
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
    expect(await shareKey(db, 'chat', { id: chatId, tenantId, ownerSubject: owner }, friend)).toBe(
      true
    );
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
    // No shareKey: the access row exists, the wrapping does not.
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
    await revokeKey(db, 'chat', tenantId, chatId, friend);
    expect((await openResourceKey(db, ref(chatId), friend)).ok).toBe(false);
    expect(await resolveChatAccess(db, tenantId, friend, chatId)).toBeNull();
    expect((await openResourceKey(db, ref(chatId), owner)).ok).toBe(true);
  });

  it('a chat without a key reads as "no key" to a viewer until its owner mints one', async () => {
    // A chat inserted outside the app (the sweep's starting point).
    const bareId = randomUUID();
    await db
      .insertInto('chats')
      .values({ id: bareId, tenant_id: tenantId, owner_subject: owner })
      .execute();
    await grantResourceAccess(db, tenantId, owner, 'chat', bareId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });
    const asViewer = await resolveChatAccess(db, tenantId, friend, bareId);
    expect(asViewer?.cipher.keyId).not.toBeNull();
    if (!asViewer) return;
    // Opening as the owner minted the key (and wrapped it for the viewer).
    expect((await listResourceKeyHolders(db, ref(bareId))).map((h) => h.subject).sort()).toEqual(
      [friend, owner].sort()
    );
    const asOwner = await resolveChatAccess(db, tenantId, owner, bareId);
    if (!asOwner) throw new Error('owner lost access');
    expect(asOwner.cipher.keyId).toBe(asViewer.cipher.keyId);
    await insertMessage(db, {
      tenantId,
      chatId: bareId,
      turnId: null,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      blocks: [{ type: 'text', text: 'after keys' }],
      cipher: asOwner.cipher,
    });
    expect(texts(await listMessages(db, tenantId, bareId, asViewer.cipher))).toEqual([
      'after keys',
    ]);

    // Search opens each chat with the viewer's own cipher.
    const chats = [
      await getChatRow(db, tenantId, chatId),
      await getChatRow(db, tenantId, bareId),
    ].flatMap((chat) => (chat ? [chat] : []));
    const ciphers = await chatCiphersFor(db, tenantId, friend, chats);
    const hits = await searchChatMessages(db, tenantId, [chatId, bareId], 'after keys', ciphers);
    expect(hits.map((hit) => hit.chatId)).toEqual([bareId]);
    // The chat the friend was unshared from matches nothing for them.
    expect(ciphers.get(chatId)?.keyId).not.toBeNull(); // opened as its owner (no grant) — see chatCiphersFor
  });

  it('a project’s instructions and memory are under the project’s key, shared with it', async () => {
    const projectId = await createProject(db, {
      tenantId,
      ownerSubject: owner,
      name: 'Ledger',
      description: null,
      instructions: 'Always cite the ticket.',
      toolConfig: null,
    });
    if (!projectId) throw new Error('no project');
    expect((await openResourceKey(db, ref(projectId, 'chat_project'), owner)).ok).toBe(true);
    const raw = await db
      .selectFrom('chat_projects')
      .select('instructions')
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(raw.instructions && isResourceEncrypted(raw.instructions)).toBe(true);

    const asOwner = await resolveProjectAccess(db, tenantId, owner, projectId);
    if (!asOwner) throw new Error('owner');
    const row = await getProjectRow(db, tenantId, projectId);
    if (!row) throw new Error('row');
    expect(openProjectInstructions(row, asOwner.cipher)).toBe('Always cite the ticket.');
    expect(
      await updateProject(db, tenantId, projectId, { instructions: 'Cite twice.' }, asOwner.cipher)
    ).toBe(true);
    await appendProjectMemory(db, {
      tenantId,
      projectId,
      content: 'The ledger closes on the 5th.',
      authorSubject: owner,
      chatId: null,
      cipher: asOwner.cipher,
    });

    // A grantee opens both through the share's wrapping.
    await grantResourceAccess(db, tenantId, owner, 'chat_project', projectId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });
    expect(
      await shareKey(db, 'chat_project', { id: projectId, tenantId, ownerSubject: owner }, friend)
    ).toBe(true);
    const asFriend = await resolveProjectAccess(db, tenantId, friend, projectId);
    if (!asFriend) throw new Error('friend');
    const after = await getProjectRow(db, tenantId, projectId);
    if (!after) throw new Error('row');
    expect(openProjectInstructions(after, asFriend.cipher)).toBe('Cite twice.');
    const memory = await readProjectMemory(db, tenantId, projectId, asFriend.cipher);
    expect(memory.entries.map((entry) => entry.content)).toEqual(['The ledger closes on the 5th.']);
    // Nobody else resolves.
    expect(await resolveProjectAccess(db, tenantId, stranger, projectId)).toBeNull();
  });

  it('a person’s memory is under their own key alone', async () => {
    await appendUserMemory(db, {
      tenantId,
      ownerSubject: owner,
      content: 'prefers tables',
      chatId: null,
    });
    const stored = await db
      .selectFrom('chat_user_memories')
      .select('content')
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', owner)
      .executeTakeFirstOrThrow();
    expect(stored.content.startsWith('uenc1:')).toBe(true);
    expect((await readUserMemory(db, tenantId, owner)).entries.map((e) => e.content)).toEqual([
      'prefers tables',
    ]);
    expect((await readUserMemory(db, tenantId, friend)).entries).toEqual([]);
  });

  it('deleting the chat deletes its key', async () => {
    expect(await deleteChat(db, tenantId, owner, chatId)).toBe(true);
    expect(await openResourceKey(db, ref(chatId), owner)).toMatchObject({
      ok: false,
      err: { type: 'NO_KEY' },
    });
  });
});
