/**
 * A temporary chat's rules at the routes, on the memory store: the switch
 * changes only while the chat is empty, and a temporary chat is never in a
 * project — not started in one, not moved into one, not switched on in
 * one. These were chat-temporary.spec.ts's requests after the reply.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
// The chat's own key needs the delegate, which a route's temporary rules never reach.
jest.mock('@/lib/chat/chat-keys', () => ({
  ...jest.requireActual('@/lib/chat/chat-keys'),
  createKey: jest.fn(),
  wrapKeyUnderProject: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createChat } from '@/lib/chat/store';
import { createProject } from '@/lib/chat/projects';
import { POST as createPOST } from '../route';
import { POST as movePOST } from './move/route';
import { PATCH } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const ME = 'alice';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
});

afterEach(() => resetDataStore());

const params = (chatId: string) => ({ params: Promise.resolve({ chatId }) });
const request = (method: string, body: unknown) =>
  new NextRequest('http://test.local/api/chat/chats', { method, body: JSON.stringify(body) });

async function newChat(more: { temporary?: boolean; projectId?: string | null } = {}) {
  return createChat({
    ownerSubject: ME,
    projectId: more.projectId ?? null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    temporary: more.temporary,
  });
}

async function newProject(): Promise<string> {
  const id = await createProject({
    ownerSubject: ME,
    name: 'Hiring',
    description: null,
    instructions: null,
    toolConfig: null,
  });
  if (!id) throw new Error('project not created');
  return id;
}

describe('the Temporary switch', () => {
  it('turns on while the chat is empty, and holds', async () => {
    const chatId = await newChat();
    const response = await PATCH(request('PATCH', { temporary: true }), params(chatId));
    expect(response.status).toBe(200);
    expect((await getDataStore().chats.get(chatId))?.temporary).toBe(true);
  });

  it('is refused once the chat has a message', async () => {
    const chatId = await newChat({ temporary: true });
    await getDataStore().chats.touch(chatId, {});
    const response = await PATCH(request('PATCH', { temporary: false }), params(chatId));
    expect(response.status).toBe(409);
    expect((await getDataStore().chats.get(chatId))?.temporary).toBe(true);
  });

  it('asking for what it already is changes nothing and is not refused', async () => {
    const chatId = await newChat({ temporary: true });
    await getDataStore().chats.touch(chatId, {});
    const response = await PATCH(request('PATCH', { temporary: true }), params(chatId));
    expect(response.status).toBe(200);
  });

  it('cannot be switched on in a project', async () => {
    const chatId = await newChat({ projectId: await newProject() });
    const response = await PATCH(request('PATCH', { temporary: true }), params(chatId));
    expect(response.status).toBe(400);
  });
});

describe('a temporary chat stays out of projects', () => {
  it('cannot be started in one', async () => {
    const projectId = await newProject();
    const response = await createPOST(request('POST', { projectId, temporary: true }));
    expect(response.status).toBe(400);
    const ordinary = await createPOST(request('POST', { projectId }));
    expect(ordinary.status).toBe(201);
  });

  it('cannot be moved into one; an ordinary chat can', async () => {
    const projectId = await newProject();
    const temporary = await newChat({ temporary: true });
    expect((await movePOST(request('POST', { projectId }), params(temporary))).status).toBe(400);
    expect((await getDataStore().chats.get(temporary))?.projectId).toBeNull();
    const ordinary = await newChat();
    expect((await movePOST(request('POST', { projectId }), params(ordinary))).status).toBe(200);
  });
});
