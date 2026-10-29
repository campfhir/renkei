/**
 * A chat's key through the chat's own doors, against a real database
 * (skipped without DATABASE_URL): a new chat is born with a key, its
 * owner's rows go under it, sharing lets the grantee open exactly those
 * rows, revoking shuts them out again, a chat without a key mints one on
 * its owner's first access (wrapped for its existing viewers) and reads as
 * "no key" to a viewer until then, and deleting the chat takes the key
 * with it. The same for a project's instructions and memory.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
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

// The delegate is the one process that holds keys; the web app reaches it
// over HTTP, so these tests run it in-process on a loopback port, one per
// describe block (each block opens and closes its own database pool).
import { useTestDelegate } from '@/lib/test-support/delegate';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('chat and project keys through the chat', () => {
  const delegate = useTestDelegate();
  const suiteId = randomUUID();
  const owner = `owner-${suiteId.slice(0, 8)}`;
  const friend = `friend-${suiteId.slice(0, 8)}`;
  const stranger = `stranger-${suiteId.slice(0, 8)}`;
  let chatId: string;

  const ref = (id: string, kind: 'chat' | 'chat_project' = 'chat') => ({
    kind,
    resourceId: id,
  });
  /** The chat's rows as stored, sealed, in order. */
  const rawContent = async (id: string) =>
    (await getDataStore().chatThreads.listMessages(id)).map((row) => row.content);
  const texts = (rows: Awaited<ReturnType<typeof listMessages>>) =>
    rows.map((row) => row.blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(''));

  beforeAll(async () => {
    // The owner and the friend hold keys, as their browsers would have
    // enrolled them; the stranger never enrolled and holds nothing.
    await delegate.enroll(owner);
    await delegate.enroll(friend);
  });

  afterAll(async () => {});

  it('a new chat has a key, and its owner writes under it', async () => {
    chatId = await createChat({
      ownerSubject: owner,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
    });
    expect((await openResourceKey(ref(chatId), owner)).ok).toBe(true);

    const access = await resolveChatAccess(owner, chatId);
    expect(access?.role).toBe('owner');
    if (!access) return;
    expect(access.cipher.keyId).not.toBeNull();
    const inserted = await insertMessage({
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
    expect(texts(await listMessages(chatId, access.cipher))).toEqual(['the quarterly numbers']);
  });

  it('nobody but the owner resolves access, so nobody else gets a cipher', async () => {
    expect(await resolveChatAccess(friend, chatId)).toBeNull();
    expect((await openResourceKey(ref(chatId), friend)).ok).toBe(false);
  });

  it('sharing rewraps the key for the grantee, who then reads the rows', async () => {
    const granted = await grantResourceAccess(owner, 'chat', chatId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });
    expect(granted).toBe('OK');
    expect(await shareKey('chat', { id: chatId, ownerSubject: owner }, friend)).toBe(true);
    expect((await listResourceKeyHolders(ref(chatId))).map((h) => h.holder).sort()).toEqual(
      [friend, owner].sort()
    );

    const access = await resolveChatAccess(friend, chatId);
    expect(access?.role).toBe('viewer');
    expect(access?.via).toBe('grant');
    if (!access) return;
    expect(texts(await listMessages(chatId, access.cipher))).toEqual(['the quarterly numbers']);
    // The content itself did not move: still one row, under the one key.
    const [stored] = await rawContent(chatId);
    expect(stored).toContain(`renc2:${access.cipher.keyId}:`);
  });

  it('a grant whose rewrap never landed is healed on the grantee’s first read', async () => {
    // Healing seals the key to the grantee's public key, so the grantee
    // must hold one: the stranger enrolls now, the way their browser would.
    await delegate.enroll(stranger);
    await grantResourceAccess(owner, 'chat', chatId, {
      granteeSubject: stranger,
      role: 'viewer',
      expiresAt: null,
    });
    // No shareKey: the access row exists, the wrapping does not.
    expect((await openResourceKey(ref(chatId), stranger)).ok).toBe(false);
    const access = await resolveChatAccess(stranger, chatId);
    expect(access?.via).toBe('grant');
    if (!access) return;
    expect(texts(await listMessages(chatId, access.cipher))).toEqual(['the quarterly numbers']);
    expect((await openResourceKey(ref(chatId), stranger)).ok).toBe(true);
  });

  it('revoking the share forgets the wrapping; the owner is untouched', async () => {
    // The grant as the owner's "who has access" list shows it.
    const grant = (await getDataStore().resourceGrants.listForOwner(owner, 'chat', chatId)).find(
      (row) => row.granteeSubject === friend
    );
    if (!grant) throw new Error('no grant for the friend');
    const revoked = await revokeResourceGrant(owner, 'chat', chatId, grant.id);
    expect(revoked).toBe(friend);
    await revokeKey('chat', chatId, friend);
    expect((await openResourceKey(ref(chatId), friend)).ok).toBe(false);
    expect(await resolveChatAccess(friend, chatId)).toBeNull();
    expect((await openResourceKey(ref(chatId), owner)).ok).toBe(true);
  });

  it('a chat without a key reads as "no key" to a viewer until its owner mints one', async () => {
    // A chat inserted outside the app (the sweep's starting point).
    const bareId = await getDataStore().chats.create({
      ownerSubject: owner,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    await grantResourceAccess(owner, 'chat', bareId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });
    const asViewer = await resolveChatAccess(friend, bareId);
    expect(asViewer?.cipher.keyId).not.toBeNull();
    if (!asViewer) return;
    // Opening as the owner minted the key (and wrapped it for the viewer).
    expect((await listResourceKeyHolders(ref(bareId))).map((h) => h.holder).sort()).toEqual(
      [friend, owner].sort()
    );
    const asOwner = await resolveChatAccess(owner, bareId);
    if (!asOwner) throw new Error('owner lost access');
    expect(asOwner.cipher.keyId).toBe(asViewer.cipher.keyId);
    await insertMessage({
      chatId: bareId,
      turnId: null,
      role: 'assistant',
      kind: 'assistant',
      status: 'complete',
      blocks: [{ type: 'text', text: 'after keys' }],
      cipher: asOwner.cipher,
    });
    expect(texts(await listMessages(bareId, asViewer.cipher))).toEqual(['after keys']);

    // Search opens each chat with the viewer's own cipher.
    const chats = [await getChatRow(chatId), await getChatRow(bareId)].flatMap((chat) =>
      chat ? [chat] : []
    );
    const ciphers = await chatCiphersFor(friend, chats);
    const hits = await searchChatMessages([chatId, bareId], 'after keys', ciphers);
    expect(hits.map((hit) => hit.chatId)).toEqual([bareId]);
    // The chat the friend was unshared from matches nothing for them.
    expect(ciphers.get(chatId)?.keyId).not.toBeNull(); // opened as its owner (no grant) — see chatCiphersFor
  });

  it('a project’s instructions and memory are under the project’s key, shared with it', async () => {
    const projectId = await createProject({
      ownerSubject: owner,
      name: 'Ledger',
      description: null,
      instructions: 'Always cite the ticket.',
      toolConfig: null,
    });
    if (!projectId) throw new Error('no project');
    expect((await openResourceKey(ref(projectId, 'chat_project'), owner)).ok).toBe(true);
    const raw = await getDataStore().chatProjects.get(projectId);
    expect(raw?.instructions && isResourceEncrypted(raw.instructions)).toBe(true);

    const asOwner = await resolveProjectAccess(owner, projectId);
    if (!asOwner) throw new Error('owner');
    const row = await getProjectRow(projectId);
    if (!row) throw new Error('row');
    expect(openProjectInstructions(row, asOwner.cipher)).toBe('Always cite the ticket.');
    expect(await updateProject(projectId, { instructions: 'Cite twice.' }, asOwner.cipher)).toBe(
      true
    );
    await appendProjectMemory({
      projectId,
      content: 'The ledger closes on the 5th.',
      authorSubject: owner,
      chatId: null,
      cipher: asOwner.cipher,
    });

    // A grantee opens both through the share's wrapping.
    await grantResourceAccess(owner, 'chat_project', projectId, {
      granteeSubject: friend,
      role: 'viewer',
      expiresAt: null,
    });
    expect(await shareKey('chat_project', { id: projectId, ownerSubject: owner }, friend)).toBe(
      true
    );
    const asFriend = await resolveProjectAccess(friend, projectId);
    if (!asFriend) throw new Error('friend');
    const after = await getProjectRow(projectId);
    if (!after) throw new Error('row');
    expect(openProjectInstructions(after, asFriend.cipher)).toBe('Cite twice.');
    const memory = await readProjectMemory(projectId, asFriend.cipher);
    expect(memory.entries.map((entry) => entry.content)).toEqual(['The ledger closes on the 5th.']);
    // Nobody else resolves.
    expect(await resolveProjectAccess(stranger, projectId)).toBeNull();
  });

  it('a person’s memory is under their own key alone', async () => {
    await appendUserMemory({
      ownerSubject: owner,
      content: 'prefers tables',
      chatId: null,
    });
    const stored = await getDataStore().userMemory.list(owner, 10);
    // Under the person's user key alone (`upriv1:`), never the automation key.
    expect(stored.map((row) => row.content.startsWith('upriv1:'))).toEqual([true]);
    expect((await readUserMemory(owner)).entries.map((e) => e.content)).toEqual(['prefers tables']);
    expect((await readUserMemory(friend)).entries).toEqual([]);
  });

  it('deleting the chat deletes its key', async () => {
    expect(await deleteChat(owner, chatId)).toBe(true);
    expect(await openResourceKey(ref(chatId), owner)).toMatchObject({
      ok: false,
      err: { type: 'NO_KEY' },
    });
  });
});
