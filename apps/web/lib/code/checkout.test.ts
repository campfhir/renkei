/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * A code chat's checkout prepared ahead of its first turn: the clone
 * started and waited on and the worktree made when a chat is created or
 * opened; nothing done for a chat whose worktree is ready, or outside a
 * code project; one preparation per chat, joined; and a turn that gave
 * up waiting woken with a note once the checkout settles — ready or not
 * — retried while the chat is mid-turn.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sandboxWorkspacesEnabled: jest.fn(async () => true),
  sbWorkspaceGet: jest.fn(),
  clientFailure: jest.fn(() => ({ status: 400, message: 'failed' })),
}));
jest.mock('./projects', () => ({ startProjectClone: jest.fn(), startChatWorktree: jest.fn() }));
jest.mock('@/lib/chat/store', () => ({ getChatRow: jest.fn() }));
jest.mock('@/lib/chat/projects', () => ({ getProjectRow: jest.fn() }));
jest.mock('@/lib/chat/tasks/wake', () => ({ openNoteTurn: jest.fn() }));
jest.mock('@/lib/sandbox/workspace-git', () => ({
  resolveWorkspaceGitAccess: jest.fn(async () => ({
    gitProxy: {
      base: 'http://delegate:8096/git/t/bitbucket.org/',
      insteadOf: 'https://bitbucket.org/',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
    username: 'alice',
  })),
}));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => 'https://r.example' }));

import { sbWorkspaceGet } from '@renkei/sandbox-client';
import type { OpenWakeTurn } from '@/lib/chat/tasks/wake';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { getChatRow } from '@/lib/chat/store';
import { startChatWorktree, startProjectClone } from './projects';
import {
  checkoutWakeText,
  hasCheckoutWake,
  registerCheckoutWake,
  resetCheckoutRegistryForTests,
  startCheckoutPreparation,
} from './checkout';

const get = sbWorkspaceGet as jest.MockedFunction<typeof sbWorkspaceGet>;
const clone = startProjectClone as jest.MockedFunction<typeof startProjectClone>;
const worktree = startChatWorktree as jest.MockedFunction<typeof startChatWorktree>;
const chatRow = getChatRow as jest.MockedFunction<typeof getChatRow>;
const row = getProjectRow as jest.MockedFunction<typeof getProjectRow>;

function project(workspaceId: string | null, kind: 'code' | 'chat' = 'code'): ProjectRow {
  return {
    id: 'p1',
    ownerSubject: 'alice',
    name: 'Billing',
    description: null,
    sealedInstructions: null,
    toolConfig: null,
    kind,
    repo:
      kind === 'code'
        ? { provider: 'atlassian-bitbucket', fullName: 'acme/billing', branch: 'main' }
        : null,
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ProjectRow;
}

const workspace = (status: 'cloning' | 'ready' | 'failed', extra: Record<string, unknown> = {}) =>
  ({
    id: 'ws-1',
    provider: 'atlassian-bitbucket',
    repoFullName: 'acme/billing',
    parentId: null,
    branch: 'main',
    status,
    error: null,
    sizeBytes: 1,
    createdAt: '',
    lastUsedAt: '',
    expiresAt: '',
    worker: null,
    ...extra,
  }) as never;

const chat = (workspaceId: string | null = null) =>
  ({ id: 'c1', projectId: 'p1', workspaceId, ownerSubject: 'alice' }) as never;

const tree = workspace('ready', { id: 'wt-1', parentId: 'ws-1', branch: 'renkei/c1' });

beforeEach(() => {
  jest.clearAllMocks();
  resetCheckoutRegistryForTests();
});

describe('startCheckoutPreparation', () => {
  it('clones when there is no checkout, waits for it, and makes the chat its worktree', async () => {
    chatRow.mockResolvedValue(chat());
    row.mockResolvedValue(project(null));
    clone.mockResolvedValue({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: true, val: tree });
    const outcome = await startCheckoutPreparation({ chatId: 'c1', subject: 'alice' });
    expect(clone).toHaveBeenCalledTimes(1);
    expect(worktree).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, cloned: true, worktree: { id: 'wt-1' } });
  }, 10_000);

  it('does nothing for a chat whose worktree is ready, a chat project, or a chat outside projects', async () => {
    chatRow.mockResolvedValue(chat('wt-1'));
    row.mockResolvedValue(project('ws-1'));
    get.mockResolvedValue({ ok: true, val: tree });
    expect(await startCheckoutPreparation({ chatId: 'c1', subject: 'alice' })).toBeNull();
    expect(clone).not.toHaveBeenCalled();
    expect(worktree).not.toHaveBeenCalled();
    // Remembered: a second open asks the worker nothing.
    get.mockClear();
    expect(await startCheckoutPreparation({ chatId: 'c1', subject: 'alice' })).toBeNull();
    expect(get).not.toHaveBeenCalled();

    row.mockResolvedValue(project(null, 'chat'));
    expect(await startCheckoutPreparation({ chatId: 'c1', subject: 'alice' })).toBeNull();
    chatRow.mockResolvedValue({ id: 'c2', projectId: null, workspaceId: null } as never);
    expect(await startCheckoutPreparation({ chatId: 'c2', subject: 'alice' })).toBeNull();
  });

  it('runs once per chat at a time: a second caller joins the first', async () => {
    chatRow.mockResolvedValue(chat());
    row.mockResolvedValue(project('ws-1'));
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: true, val: tree });
    const [first, second] = await Promise.all([
      startCheckoutPreparation({ chatId: 'c1', subject: 'alice' }),
      startCheckoutPreparation({ chatId: 'c1', subject: 'alice' }),
    ]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(worktree).toHaveBeenCalledTimes(1);
  });

  it('wakes a turn that gave up waiting, once the checkout is ready, as the person', async () => {
    chatRow.mockResolvedValue(chat());
    row.mockResolvedValue(project('ws-1'));
    get.mockResolvedValueOnce({ ok: true, val: workspace('cloning') });
    get.mockResolvedValueOnce({ ok: true, val: workspace('ready') });
    worktree.mockResolvedValue({ ok: true, val: tree });
    const open = jest
      .fn<ReturnType<OpenWakeTurn>, Parameters<OpenWakeTurn>>()
      .mockResolvedValue({ ok: true });
    const prepared = startCheckoutPreparation({ chatId: 'c1', subject: 'alice', open });
    // The turn arrives while the clone runs and leaves a wake.
    registerCheckoutWake({ chatId: 'c1', session: { subject: 'alice', roles: ['renkei-user'] } });
    expect(hasCheckoutWake('c1')).toBe(true);
    await prepared;
    expect(open).toHaveBeenCalledWith({
      session: { subject: 'alice', roles: ['renkei-user'] },
      chatId: 'c1',
      text: expect.stringContaining('Checkout ready: acme/billing'),
    });
    expect(open.mock.calls[0]![0].text).toContain('renkei/c1');
    expect(hasCheckoutWake('c1')).toBe(false);
  }, 10_000);

  it('tries the wake again while the chat is mid-turn, and says so when the clone failed', async () => {
    chatRow.mockResolvedValue(chat());
    row.mockResolvedValue(project('ws-1'));
    get.mockResolvedValueOnce({ ok: true, val: workspace('failed', { error: 'no such repo' }) });
    // The clone is tried again from a failed one, and fails again.
    clone.mockResolvedValue({ ok: false, status: 409, message: 'no such repo' });
    const open = jest
      .fn<ReturnType<OpenWakeTurn>, Parameters<OpenWakeTurn>>()
      .mockResolvedValueOnce({ ok: false, running: true })
      .mockResolvedValueOnce({ ok: true });
    // A wake left by a turn, with this preparation the one to deliver it.
    globalThis.__renkeiCheckoutRegistry = {
      preparations: new Map(),
      wakes: new Map([['c1', { subject: 'alice', roles: [] }]]),
      readyUntil: new Map(),
    };
    const outcome = await startCheckoutPreparation({
      chatId: 'c1',
      subject: 'alice',
      open,
      retryMs: 1,
    });
    expect(outcome).toMatchObject({ ok: false, message: 'no such repo' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]![0].text).toContain('Checkout not ready');
    expect(open.mock.calls[1]![0].text).toContain('no such repo');
    expect(hasCheckoutWake('c1')).toBe(false);
  });
});

describe('checkoutWakeText', () => {
  it('tells the model to carry on, or to tell the person', () => {
    expect(
      checkoutWakeText('acme/billing', {
        ok: true,
        worktree: tree,
        cloned: true,
        seconds: 42,
      })
    ).toMatch(/^Checkout ready: acme\/billing .*42s.* renkei\/c1\. The code_\* tools work now/);
    expect(checkoutWakeText('acme/billing', { ok: false, message: 'it broke.', seconds: 3 })).toBe(
      'Checkout not ready: acme/billing could not be prepared — it broke. Tell the person in a sentence; the next message tries again.'
    );
  });
});
