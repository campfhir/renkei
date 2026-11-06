/**
 * The tasks dialog's routes on the memory store: anyone who may read the
 * chat reads its list, its wait and the running turn, or the list as a
 * Markdown file; only the owner completes, cancels or deletes a task, by
 * the same rules the model's tools follow (a refusal answers 409 with
 * the reason) — and finishing a task wakes a chat suspended on it.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/chat/access', () => ({ resolveChatAccess: jest.fn() }));
jest.mock('@/lib/chat/chat-keys', () => ({
  chatCipherById: jest.fn(async () =>
    jest.requireActual('@/lib/chat/content-crypto').resourceCipher({
      id: '00000000-0000-4000-8000-00000000c1fe',
      key: Buffer.alloc(32, 7),
    })
  ),
}));
jest.mock('@/lib/chat/start-turn', () => ({ startChatTurn: jest.fn() }));

import { NextRequest } from 'next/server';
import { ok } from '@campfhir/safe-functions/helpers';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { resourceCipher } from '@/lib/chat/content-crypto';
import { createTask } from '@/lib/chat/tasks/store';
import { suspendOnTasks, cancelTaskWait } from '@/lib/chat/tasks/wake';
import { GET } from './route';
import { DELETE, PATCH } from './[taskId]/route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>(
  '@/lib/session'
);
const { resolveChatAccess } = jest.requireMock<{ resolveChatAccess: jest.Mock }>(
  '@/lib/chat/access'
);
const { startChatTurn } = jest.requireMock<{ startChatTurn: jest.Mock }>('@/lib/chat/start-turn');

const cipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});
const CHAT = '00000000-0000-4000-8000-0000000000c1';

function as(role: 'owner' | 'viewer') {
  resolveChatAccess.mockResolvedValue({
    role,
    cipher,
    chat: { id: CHAT, title: 'Release notes', ownerSubject: 'ann' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  getSessionFromRequest.mockResolvedValue({ subject: 'ann', roles: ['renkei-user'] });
  startChatTurn.mockResolvedValue(ok({ turnId: 'woken' }));
  as('owner');
});

afterEach(async () => {
  await cancelTaskWait(CHAT);
  resetDataStore();
});

const url = (path = '') => `http://test.local/api/chat/chats/${CHAT}/tasks${path}`;
const listParams = { params: Promise.resolve({ chatId: CHAT }) };
const taskParams = (taskId: string) => ({ params: Promise.resolve({ chatId: CHAT, taskId }) });
const patch = (taskId: string, body: unknown) =>
  PATCH(
    new NextRequest(url(`/${taskId}`), { method: 'PATCH', body: JSON.stringify(body) }),
    taskParams(taskId)
  );

async function plan() {
  const now = new Date();
  const parent = await createTask(
    CHAT,
    cipher,
    { title: 'Write notes', createdBy: 'assistant' },
    now
  );
  if (!parent.ok) throw new Error(parent.reason);
  const sub = await createTask(
    CHAT,
    cipher,
    { title: 'Collect changes', parent: parent.task.id, start: true, createdBy: 'assistant' },
    now
  );
  if (!sub.ok) throw new Error(sub.reason);
  return { parent: parent.task, sub: sub.task };
}

describe('GET tasks', () => {
  it('answers the list opened, with no wait and no turn', async () => {
    await plan();
    as('viewer');
    const response = await GET(new NextRequest(url()), listParams);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.tasks.map((task: { number: number; title: string }) => [task.number, task.title])
    ).toEqual([
      [1, 'Write notes'],
      [2, 'Collect changes'],
    ]);
    expect(body.wait).toBeNull();
    expect(body.activeTurn).toBeNull();
  });

  it('answers the list as a Markdown file to save', async () => {
    await plan();
    const response = await GET(new NextRequest(url('?format=markdown')), listParams);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toContain('tasks.md');
    const text = await response.text();
    expect(text).toContain('# Tasks — Release notes');
    expect(text).toContain('  - [ ] **#2** Collect changes — _in progress_');
  });

  it('a chat the viewer cannot read is not found', async () => {
    resolveChatAccess.mockResolvedValue(null);
    expect((await GET(new NextRequest(url()), listParams)).status).toBe(404);
  });
});

describe('the owner acting on a task', () => {
  it('a refusal says why, by the tools’ own rules', async () => {
    const { parent } = await plan();
    const response = await patch(parent.id, { action: 'complete' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      '#1 still has open subtasks: #2. Complete or cancel them first.'
    );
  });

  it('completing the task a chat waits on wakes it', async () => {
    const { sub } = await plan();
    await suspendOnTasks({
      chatId: CHAT,
      taskIds: [sub.id],
      events: ['completed'],
      mode: 'all',
      timeoutSeconds: 600,
      session: { subject: 'ann', roles: ['renkei-user'] },
      now: new Date(),
    });
    const response = await patch(sub.id, { action: 'complete' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks[1].status).toBe('completed');
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(startChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT,
        kind: 'note',
        text: expect.stringContaining('Task wait finished'),
      })
    );
  });

  it('cancelling takes the open subtasks along; deleting removes the subtree', async () => {
    const { parent } = await plan();
    const cancelled = await (await patch(parent.id, { action: 'cancel' })).json();
    expect(cancelled.tasks.map((task: { status: string }) => task.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    const deleted = await DELETE(
      new NextRequest(url(`/${parent.id}`), { method: 'DELETE' }),
      taskParams(parent.id)
    );
    expect((await deleted.json()).tasks).toEqual([]);
  });

  it('a viewer may not change tasks, and an unknown action is refused', async () => {
    const { sub } = await plan();
    expect((await patch(sub.id, { action: 'reopen' })).status).toBe(400);
    as('viewer');
    expect((await patch(sub.id, { action: 'complete' })).status).toBe(403);
  });
});
