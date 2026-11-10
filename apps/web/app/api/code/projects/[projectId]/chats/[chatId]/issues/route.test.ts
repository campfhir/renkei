/**
 * Issue cards for a chat (GET /api/code/projects/:id/chats/:chatId/issues),
 * on the memory store: what issue-cards.spec.ts used to read off the real
 * route through a page — a project whose branch names no issue and a chat
 * with no pull request yet answer nothing to look up, with no error, so
 * the cards stay hidden (issue-cards.model.ts). A chat the person cannot
 * reach is not found.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const ME = 'member@example.com';

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockGetSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
});

afterEach(() => resetDataStore());

function codeProject(): Promise<string> {
  return getDataStore().chatProjects.create({
    ownerSubject: ME,
    name: 'Issue cards',
    description: null,
    toolConfig: null,
    repo: { provider: 'github', fullName: 'acme/site', branch: 'main' },
  });
}

function chatIn(projectId: string): Promise<string> {
  return getDataStore().chats.create({
    ownerSubject: ME,
    projectId,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
}

function read(projectId: string, chatId: string) {
  return GET(
    new NextRequest(`http://test.local/api/code/projects/${projectId}/chats/${chatId}/issues`),
    { params: Promise.resolve({ projectId, chatId }) }
  );
}

describe('GET /api/code/projects/:id/chats/:chatId/issues', () => {
  it('answers nothing to show when the branch names no issue and the chat has no pull request', async () => {
    const projectId = await codeProject();
    const chatId = await chatIn(projectId);

    const response = await read(projectId, chatId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jira: null, github: null });
  });

  it('someone else’s chat is not found', async () => {
    const projectId = await codeProject();
    const theirs = await getDataStore().chats.create({
      ownerSubject: 'someone@example.com',
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    expect((await read(projectId, theirs)).status).toBe(404);
  });
});
