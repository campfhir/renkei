/**
 * Every decision that applies to tools in a chat (GET/PUT
 * /api/chat/chats/:chatId/tool-answers), on the memory store: this chat's
 * own, the person's always-lists and the organization's locks in one read;
 * a reset takes one decision back off the list it names; nobody but the
 * owner finds the chat.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
// The catalog reaches every connector's registration; one fixed group stands in.
jest.mock('@/lib/chat/permission-catalog', () => ({
  listChatToolGroups: async () => [
    {
      key: 'renkei-chat',
      label: 'The chat itself',
      tools: [
        { name: 'chat_memory_list', label: 'List memories', read: true },
        { name: 'chat_memory_remember', label: 'Remember' },
      ],
    },
  ],
}));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateSettingsCache, setOrgSettings } from '@renkei/settings';
import { rememberChatToolAnswer } from '@/lib/chat/chat-permissions';
import {
  getChatToolPermissionPrefs,
  setChatToolPermissionPrefs,
} from '@/lib/chat/permission-prefs';
import { GET, PUT } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

let me: string;

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  invalidateSettingsCache();
  me = `alice-${randomUUID()}`;
  mockGetSession.mockImplementation(async () => ({ subject: me, roles: ['renkei-user'] }));
});

afterEach(() => {
  resetDataStore();
  invalidateSettingsCache();
});

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
const get = async (chatId: string) =>
  (await GET(new NextRequest('http://test.local/x'), params(chatId))).json();
const put = (chatId: string, body: unknown) =>
  PUT(
    new NextRequest('http://test.local/x', { method: 'PUT', body: JSON.stringify(body) }),
    params(chatId)
  );

describe('the decisions that apply to tools in a chat', () => {
  it('reads this chat’s own, the person’s always-lists, and which of them the organization locks', async () => {
    const chatId = await chatOf(me);
    await rememberChatToolAnswer(chatId, 'card_create', 'deny');
    await rememberChatToolAnswer(chatId, 'card_update', 'allow');
    await setChatToolPermissionPrefs(me, {
      alwaysAllow: ['outlook_send_mail'],
      alwaysDeny: ['jira_delete_issue'],
    });
    await setOrgSettings({
      lockedHighRiskTools: ['outlook_send_mail', 'github_merge_pull_request'],
    });
    expect(await get(chatId)).toEqual({
      chat: { allow: ['card_update'], deny: ['card_create'] },
      always: { allow: ['outlook_send_mail'], deny: ['jira_delete_issue'] },
      locked: ['outlook_send_mail'],
      tools: [
        {
          key: 'renkei-chat',
          label: 'The chat itself',
          tools: [
            { name: 'chat_memory_list', label: 'List memories', read: true },
            { name: 'chat_memory_remember', label: 'Remember' },
          ],
        },
      ],
    });
  });

  it('blocks a tool here or always, a reading one included (no card would ever offer it)', async () => {
    const chatId = await chatOf(me);
    const here = await put(chatId, { tool: 'chat_memory_list', rule: 'deny', scope: 'chat' });
    expect((await here.json()).chat).toEqual({ allow: [], deny: ['chat_memory_list'] });
    const always = await put(chatId, { tool: 'chat_memory_list', rule: 'deny', scope: 'always' });
    expect((await always.json()).always).toEqual({ allow: [], deny: ['chat_memory_list'] });
    expect(await getChatToolPermissionPrefs(me, { fresh: true })).toEqual({
      alwaysAllow: [],
      alwaysDeny: ['chat_memory_list'],
    });
  });

  it('a reset takes one decision back off the list it names: this chat’s, or the person’s own', async () => {
    const chatId = await chatOf(me);
    await rememberChatToolAnswer(chatId, 'card_create', 'deny');
    await setChatToolPermissionPrefs(me, { alwaysAllow: [], alwaysDeny: ['jira_delete_issue'] });

    const fromChat = await put(chatId, { tool: 'card_create', rule: 'ask', scope: 'chat' });
    expect(fromChat.status).toBe(200);
    expect((await fromChat.json()).chat).toEqual({ allow: [], deny: [] });

    const fromAlways = await put(chatId, {
      tool: 'jira_delete_issue',
      rule: 'ask',
      scope: 'always',
    });
    expect((await fromAlways.json()).always).toEqual({ allow: [], deny: [] });
    expect(await getChatToolPermissionPrefs(me, { fresh: true })).toEqual({
      alwaysAllow: [],
      alwaysDeny: [],
    });
  });

  it('never allows (that is the card’s, which knows the locks), and needs to know which list', async () => {
    const chatId = await chatOf(me);
    for (const body of [
      { tool: 'card_create', rule: 'allow', scope: 'chat' },
      { tool: 'card_create', rule: 'ask' },
      { tool: 'not a tool', rule: 'ask', scope: 'chat' },
    ]) {
      expect((await put(chatId, body)).status).toBe(400);
    }
  });

  it('nobody but the owner finds the chat', async () => {
    const chatId = await chatOf(`bob-${randomUUID()}`);
    expect((await GET(new NextRequest('http://test.local/x'), params(chatId))).status).toBe(404);
    expect((await put(chatId, { tool: 'card_create', rule: 'ask', scope: 'chat' })).status).toBe(
      404
    );
  });
});
