/**
 * Deleting a chat on the memory store: its own files go, bytes first; a
 * file a project holds, a person was shared or someone else owns is
 * detached and stays; one still under the chat's key that cannot be
 * moved keeps the chat in place.
 */

const deleteObject = jest.fn(async (_key: string): Promise<unknown> => ({ ok: true }));
jest.mock('@renkei/blob-store', () => ({
  resolveTenantBlobStore: async () => ({ ok: true, val: { deleteObject } }),
}));
jest.mock('./chat-keys', () => ({
  createKey: jest.fn(),
  deleteKey: jest.fn(async () => undefined),
  wrapKeyUnderProject: jest.fn(),
}));

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { deleteChat } from './store';

const OWNER = 'delete-chat-owner';
const OTHER = 'delete-chat-other';

async function newChat(): Promise<string> {
  return getDataStore().chats.create({
    ownerSubject: OWNER,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
    temporary: false,
  });
}

function file(chatId: string, owner: string, keyKind = 'artifact') {
  const id = randomUUID();
  return getDataStore().artifacts.create({
    id,
    ownerSubject: owner,
    chatId,
    messageId: null,
    origin: 'upload',
    keyKind,
    keyRef: keyKind === 'chat' ? chatId : null,
    blobKey: `blob/${id}`,
    filename: 'f.txt',
    contentType: 'text/plain',
    sizeBytes: 1,
    extractedText: null,
    extractStatus: 'none',
    digestStatus: 'none',
  });
}

describe('deleteChat and its files', () => {
  beforeEach(() => {
    registerDataStore(createMemoryDataStore());
    deleteObject.mockClear();
  });
  afterEach(() => resetDataStore());

  it('deletes its own files, bytes first, and keeps held, shared and foreign ones', async () => {
    const chat = await newChat();
    const own = await file(chat, OWNER);
    const held = await file(chat, OWNER);
    const shared = await file(chat, OWNER);
    const foreign = await file(chat, OTHER);
    const store = getDataStore();
    const project = await store.chatProjects.create({
      ownerSubject: OWNER,
      name: 'P',
      description: null,
      toolConfig: null,
    });
    await store.artifacts.addReference({
      artifactId: held.id,
      projectId: project,
      mode: 'on_demand',
      addedBy: OWNER,
    });
    await store.resourceGrants.upsert({
      resourceKind: 'artifact',
      resourceId: shared.id,
      ownerSubject: OWNER,
      granteeSubject: OTHER,
      role: 'viewer',
      expiresAt: null,
    });

    expect(await deleteChat(OWNER, chat)).toBe(true);
    expect(deleteObject.mock.calls.map((call) => call[0])).toEqual([own.blobKey]);
    expect(await store.artifacts.get(own.id)).toBeNull();
    for (const kept of [held, shared, foreign]) {
      expect(await store.artifacts.get(kept.id)).toMatchObject({ chatId: null });
    }
    expect(await store.chats.get(chat)).toBeNull();
  });

  it("is not the owner's to delete: nothing is touched", async () => {
    const chat = await newChat();
    const own = await file(chat, OWNER);
    expect(await deleteChat(OTHER, chat)).toBe(false);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await getDataStore().artifacts.get(own.id)).toMatchObject({ chatId: chat });
  });

  it('leaves the chat and every file when a blob cannot be deleted', async () => {
    const chat = await newChat();
    const own = await file(chat, OWNER);
    deleteObject.mockResolvedValueOnce({ ok: false, err: { type: 'STORE' } });
    await expect(deleteChat(OWNER, chat)).rejects.toThrow(/bytes/);
    expect(await getDataStore().chats.get(chat)).not.toBeNull();
    expect(await getDataStore().artifacts.get(own.id)).not.toBeNull();
  });

  it('refuses while a foreign file is still under the chat key', async () => {
    const chat = await newChat();
    const legacy = await file(chat, OTHER, 'chat');
    await expect(deleteChat(OWNER, chat)).rejects.toThrow(/outlives/);
    expect(await getDataStore().chats.get(chat)).not.toBeNull();
    expect(await getDataStore().artifacts.get(legacy.id)).toMatchObject({ chatId: chat });
  });
});
