/**
 * Concurrent chats in a code project, on the memory store: every chat works
 * in a worktree of its own on the sandbox worker. Reached through a chat,
 * the tree route reads THAT chat's worktree — never the project's base
 * clone or another chat's — and a chat that is not the project's is not
 * reachable through it; deleting a chat (DELETE /api/chat/chats/:id) takes
 * its worktree with it and only its own. code-concurrent-chats.spec.ts
 * checked these through the sandbox stub before. The worktrees' isolation
 * itself (git) is the worker's (apps/worker-sandbox); the stub the browser
 * suite runs only imitates it, so nothing here or there needs real git.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual<object>('@renkei/sandbox-client'),
  sandboxWorkspacesEnabled: jest.fn(async () => true),
  sbWorkspaceGet: jest.fn(),
  sbWorkspaceLs: jest.fn(),
  sbWorkspaceDelete: jest.fn(async () => ({ ok: true, val: undefined })),
}));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET } from './route';
import { GET as projectTree } from '../../../tree/route';
import { DELETE as deleteChat } from '@/app/api/chat/chats/[chatId]/route';

const { getSessionFromRequest: mockSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const sandbox = jest.requireMock<{
  sbWorkspaceGet: jest.Mock;
  sbWorkspaceLs: jest.Mock;
  sbWorkspaceDelete: jest.Mock;
}>('@renkei/sandbox-client');

const ME = 'coder@example.com';

/** What each checkout holds: the base clone, and a file only the first chat made. */
const FILES: Record<string, string[]> = {
  'ws-base': ['README.md'],
  'ws-first': ['README.md', 'only-in-first.txt'],
  'ws-second': ['README.md'],
};

function workspace(id: string) {
  return {
    id,
    provider: 'bitbucket',
    repoFullName: 'acme/ledger-service',
    parentId: id === 'ws-base' ? null : 'ws-base',
    branch: id === 'ws-base' ? 'main' : `renkei/${id}`,
    status: 'ready',
    error: null,
    sizeBytes: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastUsedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    worker: null,
  };
}

let projectId: string;
let firstChatId: string;
let secondChatId: string;

beforeEach(async () => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  sandbox.sbWorkspaceGet.mockImplementation(async (_target: unknown, id: string) => ({
    ok: true,
    val: workspace(id),
  }));
  sandbox.sbWorkspaceLs.mockImplementation(
    async (_target: unknown, { id, path }: { id: string; path: string }) => ({
      ok: true,
      val: {
        path,
        entries: (FILES[id] ?? []).map((name) => ({ path: name, kind: 'file', size: 1 })),
      },
    })
  );

  const store = getDataStore();
  projectId = await store.chatProjects.create({
    ownerSubject: ME,
    name: 'Ledger service',
    description: null,
    toolConfig: null,
    repo: { provider: 'bitbucket', fullName: 'acme/ledger-service', branch: 'main' },
  });
  await store.chatProjects.update(projectId, { workspaceId: 'ws-base' });
  const chat = () =>
    store.chats.create({
      ownerSubject: ME,
      projectId,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: true,
    });
  firstChatId = await chat();
  secondChatId = await chat();
  await store.chats.setWorkspace(firstChatId, 'ws-first');
  await store.chats.setWorkspace(secondChatId, 'ws-second');
});

afterEach(() => resetDataStore());

async function treeOf(chatId?: string): Promise<{ status: number; paths: string[] }> {
  const url = chatId
    ? `http://test.local/api/code/projects/${projectId}/chats/${chatId}/tree?path=`
    : `http://test.local/api/code/projects/${projectId}/tree?path=`;
  const response = chatId
    ? await GET(new NextRequest(url), { params: Promise.resolve({ projectId, chatId }) })
    : await projectTree(new NextRequest(url), { params: Promise.resolve({ projectId }) });
  if (!response.ok) return { status: response.status, paths: [] };
  const body: { entries: { path: string }[] } = await response.json();
  return { status: response.status, paths: body.entries.map((entry) => entry.path) };
}

describe('two chats in one code project', () => {
  it('a file made in one chat’s worktree is in that chat’s tree and not the other’s', async () => {
    expect((await treeOf(firstChatId)).paths).toContain('only-in-first.txt');
    expect((await treeOf(secondChatId)).paths).not.toContain('only-in-first.txt');
    // Each chat's tree is read from its own worktree.
    expect(sandbox.sbWorkspaceLs.mock.calls.map(([, { id }]) => id)).toEqual([
      'ws-first',
      'ws-second',
    ]);
  });

  it('the project’s own tree is the base clone, which no chat edits', async () => {
    const base = await treeOf();
    expect(base.paths).toEqual(['README.md']);
    expect(sandbox.sbWorkspaceLs).toHaveBeenCalledWith(
      { subject: `code-project:${projectId}` },
      { id: 'ws-base', path: '' }
    );
  });

  it('a chat that is not this project’s is not reachable through it', async () => {
    const stranger = await treeOf('00000000-0000-4000-8000-000000000000');
    expect(stranger.status).toBe(404);
    const elsewhere = await getDataStore().chats.create({
      ownerSubject: ME,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: true,
    });
    expect((await treeOf(elsewhere)).status).toBe(404);
    expect(sandbox.sbWorkspaceLs).not.toHaveBeenCalled();
  });

  it('deleting a chat takes its worktree with it, and only its own', async () => {
    const response = await deleteChat(
      new NextRequest(`http://test.local/api/chat/chats/${firstChatId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ chatId: firstChatId }) }
    );
    expect(response.status).toBe(200);
    expect(sandbox.sbWorkspaceDelete).toHaveBeenCalledTimes(1);
    expect(sandbox.sbWorkspaceDelete).toHaveBeenCalledWith(
      { subject: `code-project:${projectId}` },
      'ws-first'
    );
    // The other chat still reads its worktree.
    expect((await treeOf(secondChatId)).status).toBe(200);
  });
});
