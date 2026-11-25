/**
 * A chat's own tool answers (GET/PUT /api/chat/chats/:chatId/tool-answers),
 * on the memory store: the owner reads them and puts a tool back to
 * asking; nobody else finds the chat; only taking back is accepted here.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { rememberChatToolAnswer } from '@/lib/chat/chat-permissions';
import { GET, PUT } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

let me: string;

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  me = `alice-${randomUUID()}`;
  mockGetSession.mockImplementation(async () => ({ subject: me, roles: ['renkei-user'] }));
});

afterEach(() => resetDataStore());

async function chatOf(owner: string): Promise<string> {
  return getDataStore().chats.create({
    ownerSubject: owner,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
}

const params = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const get = (chatId: string) => GET(new NextRequest('http://test.local/x'), params(chatId));
const put = (chatId: string, body: unknown) =>
  PUT(
    new NextRequest('http://test.local/x', { method: 'PUT', body: JSON.stringify(body) }),
    params(chatId)
  );

describe('a chat’s own tool answers', () => {
  it('the owner reads them, and a reset puts a blocked tool back to asking', async () => {
    const chatId = await chatOf(me);
    await rememberChatToolAnswer(chatId, 'outlook_send_mail', 'deny');
    await rememberChatToolAnswer(chatId, 'jira_create_issue', 'allow');
    expect(await (await get(chatId)).json()).toEqual({
      allow: ['jira_create_issue'],
      deny: ['outlook_send_mail'],
    });
    const reset = await put(chatId, { tool: 'outlook_send_mail', rule: 'ask' });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ allow: ['jira_create_issue'], deny: [] });
    expect(await (await get(chatId)).json()).toEqual({ allow: ['jira_create_issue'], deny: [] });
  });

  it('Reset all takes back every answer at once', async () => {
    const chatId = await chatOf(me);
    await rememberChatToolAnswer(chatId, 'outlook_send_mail', 'deny');
    await rememberChatToolAnswer(chatId, 'jira_create_issue', 'allow');
    const reset = await put(chatId, { all: true, rule: 'ask' });
    expect(await reset.json()).toEqual({ allow: [], deny: [] });
    expect((await getDataStore().chats.get(chatId))?.toolPermissions).toBeNull();
  });

  it('only takes decisions back: allowing here, or a name that is not a tool, is refused', async () => {
    const chatId = await chatOf(me);
    expect((await put(chatId, { tool: 'outlook_send_mail', rule: 'allow' })).status).toBe(400);
    expect((await put(chatId, { tool: 'not a tool', rule: 'ask' })).status).toBe(400);
    expect(await (await get(chatId)).json()).toEqual({ allow: [], deny: [] });
  });

  it('nobody but the owner finds the chat', async () => {
    const chatId = await chatOf(`bob-${randomUUID()}`);
    expect((await get(chatId)).status).toBe(404);
    expect((await put(chatId, { tool: 'outlook_send_mail', rule: 'ask' })).status).toBe(404);
  });
});
