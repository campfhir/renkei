/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The retention sweep's temporary chats, on the memory store: one idle
 * past its day is deleted — gone, not archived — with its grants, while
 * an ordinary chat as idle, a temporary one touched within the day, and a
 * temporary one with a reply running are left alone. And retention's
 * files: a chat's own are deleted with it, bytes first, while one a project
 * holds or someone else owns outlives it, detached.
 */

let retentionDays = 0;
jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { chatRetentionDays: retentionDays } }),
}));
jest.mock('@renkei/delegate-client', () => ({
  delegateClient: () => ({ pruneOrphanResourceKeys: async () => undefined }),
}));

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { BlobStore } from '@renkei/blob-store';
import { createChatRetentionSweep } from './chat-sweep';

const OWNER = 'temporary-sweep-owner';
const HOUR_MS = 60 * 60_000;

async function newChat(temporary: boolean): Promise<string> {
  const id = await getDataStore().chats.create({
    ownerSubject: OWNER,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
    temporary,
  });
  // Written in, so the abandoned-chat sweep does not take it first.
  await getDataStore().chats.touch(id, { titleIfMissing: 'Hello' });
  return id;
}

describe('temporary chats in the retention sweep', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-01T09:00:00Z') });
    registerDataStore(createMemoryDataStore());
  });
  afterEach(() => {
    jest.useRealTimers();
    resetDataStore();
  });

  it('deletes a temporary chat idle past a day, and nothing else', async () => {
    const idle = await newChat(true);
    const ordinary = await newChat(false);
    const busy = await newChat(true);
    await getDataStore().chatThreads.createTurn({
      chatId: busy,
      kind: 'chat',
      llmModelId: null,
      thinkingBudget: null,
      runner: null,
    });
    jest.setSystemTime(Date.now() + 23 * HOUR_MS);
    const recent = await newChat(true);
    await createChatRetentionSweep(async () => null)();
    expect(await getDataStore().chats.get(idle)).not.toBeNull();

    jest.setSystemTime(Date.now() + 2 * HOUR_MS);
    await createChatRetentionSweep(async () => null)();
    expect(await getDataStore().chats.get(idle)).toBeNull();
    expect(await getDataStore().chats.get(ordinary)).toMatchObject({ archivedAt: null });
    expect(await getDataStore().chats.get(busy)).not.toBeNull();
    expect(await getDataStore().chats.get(recent)).not.toBeNull();
  });
});

describe("retention and a chat's files", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-01T09:00:00Z') });
    registerDataStore(createMemoryDataStore());
    retentionDays = 30;
  });
  afterEach(() => {
    jest.useRealTimers();
    resetDataStore();
    retentionDays = 0;
  });

  const file = (chatId: string, owner: string, keyKind: string) => {
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
  };

  it("deletes a chat's own bytes and rows, and detaches what outlives it", async () => {
    const chat = await newChat(false);
    const own = await file(chat, OWNER, 'chat');
    const held = await file(chat, OWNER, 'artifact');
    const foreign = await file(chat, 'someone-else', 'artifact');
    const project = await getDataStore().chatProjects.create({
      ownerSubject: OWNER,
      name: 'P',
      description: null,
      toolConfig: null,
    });
    await getDataStore().artifacts.addReference({
      artifactId: held.id,
      projectId: project,
      mode: 'on_demand',
      addedBy: OWNER,
    });
    const deleted: string[] = [];
    const blobs = {
      deleteObject: async (key: string) => {
        deleted.push(key);
        return { ok: true };
      },
    } as unknown as BlobStore;

    jest.setSystemTime(Date.now() + 31 * 24 * HOUR_MS);
    await createChatRetentionSweep(async () => blobs)();

    expect(await getDataStore().chats.get(chat)).toBeNull();
    expect(deleted).toEqual([own.blobKey]);
    expect(await getDataStore().artifacts.get(own.id)).toBeNull();
    expect(await getDataStore().artifacts.get(held.id)).toMatchObject({ chatId: null });
    expect(await getDataStore().artifacts.get(foreign.id)).toMatchObject({ chatId: null });
  });

  it('keeps the chat while a kept file is still under its key', async () => {
    const chat = await newChat(false);
    const legacy = await file(chat, 'someone-else', 'chat');
    jest.setSystemTime(Date.now() + 31 * 24 * HOUR_MS);
    await createChatRetentionSweep(async () => null)();
    expect(await getDataStore().chats.get(chat)).not.toBeNull();
    expect(await getDataStore().artifacts.get(legacy.id)).toMatchObject({ chatId: chat });
  });
});
