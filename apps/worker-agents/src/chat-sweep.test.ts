/**
 * The retention sweep's temporary chats, on the memory store: one idle
 * past its day is deleted — gone, not archived — with its grants, while
 * an ordinary chat as idle, a temporary one touched within the day, and a
 * temporary one with a reply running are left alone.
 */

jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { chatRetentionDays: 0 } }),
}));
jest.mock('@renkei/delegate-client', () => ({
  delegateClient: () => ({ pruneOrphanResourceKeys: async () => undefined }),
}));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
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
