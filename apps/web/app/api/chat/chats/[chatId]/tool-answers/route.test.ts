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
import { rememberProjectToolRule } from '@/lib/chat/project-permissions';
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

describe('the layers that decide tools in a chat', () => {
  it('reads this chat’s own, the person’s lists for this kind of chat, the locks and the tools', async () => {
    const chatId = await chatOf(me);
    await rememberChatToolAnswer(chatId, 'card_create', 'deny');
    await rememberChatToolAnswer(chatId, 'card_update', 'allow');
    await rememberChatToolAnswer(chatId, 'chat_memory_list', 'ask');
    await setChatToolPermissionPrefs(me, {
      alwaysAllow: ['outlook_send_mail'],
      alwaysDeny: ['jira_delete_issue'],
    });
    await setOrgSettings({ lockedHighRiskTools: ['outlook_send_mail'] });
    expect(await get(chatId)).toEqual({
      kind: 'chat',
      chat: { allow: ['card_update'], deny: ['card_create'], ask: ['chat_memory_list'] },
      project: null,
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

  it('a chat in a project reads that project’s settings, and the person’s project-chat lists', async () => {
    const projectId = await getDataStore().chatProjects.create({
      ownerSubject: me,
      name: 'Sprint',
      description: null,
      toolConfig: null,
    });
    await rememberProjectToolRule(projectId, 'card_create', 'allow');
    await setChatToolPermissionPrefs(
      me,
      { alwaysAllow: ['card_update'], alwaysDeny: [] },
      'project'
    );
    const chatId = await getDataStore().chats.create({
      ownerSubject: me,
      projectId,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    const answer = await get(chatId);
    expect(answer.kind).toBe('project');
    expect(answer.project).toEqual({ name: 'Sprint', allow: ['card_create'], ask: [] });
    expect(answer.always).toEqual({ allow: ['card_update'], deny: [] });
  });

  it('this chat: allow, ask, block and clear one tool', async () => {
    const chatId = await chatOf(me);
    const steps: [string, Record<string, string[]>][] = [
      ['allow', { allow: ['card_update'], deny: [], ask: [] }],
      ['ask', { allow: [], deny: [], ask: ['card_update'] }],
      ['deny', { allow: [], deny: ['card_update'], ask: [] }],
      ['clear', { allow: [], deny: [], ask: [] }],
    ];
    for (const [rule, chat] of steps) {
      const response = await put(chatId, { tool: 'card_update', rule, scope: 'chat' });
      expect(response.status).toBe(200);
      expect((await response.json()).chat).toEqual(chat);
    }
  });

  it('always: allow, block and clear on the person’s list for this kind of chat', async () => {
    const chatId = await chatOf(me);
    await put(chatId, { tool: 'chat_memory_list', rule: 'deny', scope: 'always' });
    expect(await getChatToolPermissionPrefs(me, { fresh: true })).toEqual({
      alwaysAllow: [],
      alwaysDeny: ['chat_memory_list'],
    });
    // Other kinds of chat keep their own lists.
    expect(await getChatToolPermissionPrefs(me, { fresh: true, kind: 'code' })).toEqual({
      alwaysAllow: [],
      alwaysDeny: [],
    });
    await put(chatId, { tool: 'chat_memory_list', rule: 'clear', scope: 'always' });
    expect(await getChatToolPermissionPrefs(me, { fresh: true })).toEqual({
      alwaysAllow: [],
      alwaysDeny: [],
    });
  });

  it('allowing a tool the organization locks is refused, here or always', async () => {
    const chatId = await chatOf(me);
    await setOrgSettings({ lockedHighRiskTools: ['outlook_send_mail'] });
    for (const scope of ['chat', 'always']) {
      const refused = await put(chatId, { tool: 'outlook_send_mail', rule: 'allow', scope });
      expect(refused.status).toBe(409);
    }
  });

  it('refuses what it does not know: "ask" always (that is the project’s or the chat’s), a bad name, no scope', async () => {
    const chatId = await chatOf(me);
    for (const body of [
      { tool: 'card_create', rule: 'ask', scope: 'always' },
      { tool: 'card_create', rule: 'clear' },
      { tool: 'not a tool', rule: 'clear', scope: 'chat' },
    ]) {
      expect((await put(chatId, body)).status).toBe(400);
    }
  });

  it('nobody but the owner finds the chat', async () => {
    const chatId = await chatOf(`bob-${randomUUID()}`);
    expect((await GET(new NextRequest('http://test.local/x'), params(chatId))).status).toBe(404);
    expect((await put(chatId, { tool: 'card_create', rule: 'clear', scope: 'chat' })).status).toBe(
      404
    );
  });
});
