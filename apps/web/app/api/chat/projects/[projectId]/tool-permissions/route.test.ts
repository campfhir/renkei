/**
 * A project's tool settings for its chats (GET/PUT
 * /api/chat/projects/:projectId/tool-permissions), on the memory store:
 * an editor sets Allow and Ask and clears them; a locked tool cannot be
 * allowed; someone without the project finds nothing.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/chat/permission-catalog', () => ({ listChatToolGroups: async () => [] }));

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateSettingsCache, setOrgSettings } from '@renkei/settings';
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

const projectOf = (owner: string) =>
  getDataStore().chatProjects.create({
    ownerSubject: owner,
    name: 'Sprint',
    description: null,
    toolConfig: null,
  });
const params = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const put = (projectId: string, body: unknown) =>
  PUT(
    new NextRequest('http://test.local/x', { method: 'PUT', body: JSON.stringify(body) }),
    params(projectId)
  );

describe('a project’s tool settings for its chats', () => {
  it('its owner sets Allow and Ask, and clears them', async () => {
    const projectId = await projectOf(me);
    expect(
      (await (await put(projectId, { tool: 'card_create', rule: 'allow' })).json()).settings
    ).toEqual({
      allow: ['card_create'],
      ask: [],
    });
    expect(
      (await (await put(projectId, { tool: 'chat_memory_list', rule: 'ask' })).json()).settings
    ).toEqual({
      allow: ['card_create'],
      ask: ['chat_memory_list'],
    });
    await put(projectId, { tool: 'card_create', rule: 'clear' });
    const read = await (
      await GET(new NextRequest('http://test.local/x'), params(projectId))
    ).json();
    expect(read).toMatchObject({
      settings: { allow: [], ask: ['chat_memory_list'] },
      canEdit: true,
    });
  });

  it('cannot allow a tool the organization locks', async () => {
    const projectId = await projectOf(me);
    await setOrgSettings({ lockedHighRiskTools: ['outlook_send_mail'] });
    expect((await put(projectId, { tool: 'outlook_send_mail', rule: 'allow' })).status).toBe(409);
  });

  it('refuses a rule it does not know, and someone the project is not shared with finds nothing', async () => {
    const projectId = await projectOf(me);
    expect((await put(projectId, { tool: 'card_create', rule: 'deny' })).status).toBe(400);
    const theirs = await projectOf(`bob-${randomUUID()}`);
    expect((await put(theirs, { tool: 'card_create', rule: 'allow' })).status).toBe(404);
  });
});
