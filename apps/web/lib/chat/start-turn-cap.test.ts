/**
 * The per-person ceiling on running replies, on the memory store: the
 * check sits right after the access decision, before any model or file work.
 */

jest.mock('./access', () => ({
  resolveChatAccess: jest.fn(async (_subject: string, chatId: string) => ({
    role: 'owner',
    chat: { id: chatId },
  })),
}));
jest.mock('next/server', () => ({ after: jest.fn() }));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { MAX_RUNNING_TURNS_PER_SUBJECT, startChatTurn } from './start-turn';

const ME = 'cap-me';

async function newChat(owner: string): Promise<string> {
  return getDataStore().chats.create({
    ownerSubject: owner,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
    temporary: false,
  });
}

async function chatWithRunningTurn(owner: string): Promise<string> {
  const chatId = await newChat(owner);
  await getDataStore().chatThreads.createTurn({
    chatId,
    kind: 'chat',
    llmModelId: null,
    thinkingBudget: null,
    runner: null,
  });
  return chatId;
}

describe('running replies per person', () => {
  beforeEach(() => registerDataStore(createMemoryDataStore()));
  afterEach(() => resetDataStore());

  it('refuses a new reply once the person has the maximum running, and only them', async () => {
    for (let i = 0; i < MAX_RUNNING_TURNS_PER_SUBJECT; i++) await chatWithRunningTurn(ME);
    for (let i = 0; i < 3; i++) await chatWithRunningTurn('someone-else');
    expect(await getDataStore().chatThreads.countRunningForOwner(ME)).toBe(
      MAX_RUNNING_TURNS_PER_SUBJECT
    );
    const idle = await newChat(ME);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only the subject is read before the check
    const session = { subject: ME } as Parameters<typeof startChatTurn>[0]['session'];
    const refused = await startChatTurn({ session, chatId: idle, text: 'hello' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.err.type).toBe('TOO_MANY_RUNNING');
  });
});
