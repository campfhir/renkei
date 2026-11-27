/**
 * One project, one checkout: starting a clone drops every other clone the
 * worker holds for the project — so clones left behind cannot add up to
 * the worker's limit — and joins a clone of the same repository and branch
 * that another request has just started, rather than making a second.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sandboxWorkspacesEnabled: jest.fn(async () => true),
  sbWorkspaceList: jest.fn(),
  sbWorkspaceDelete: jest.fn(async () => ({ ok: true, val: {} })),
  sbWorkspaceClone: jest.fn(),
  clientFailure: jest.fn(() => ({ status: 429, message: 'At most 3 workspaces at once' })),
}));
jest.mock('@/lib/chat/projects', () => ({ updateProject: jest.fn(async () => undefined) }));
jest.mock('@renkei/db', () => ({ getDataStore: jest.fn() }));

import { sbWorkspaceClone, sbWorkspaceDelete, sbWorkspaceList } from '@renkei/sandbox-client';
import { updateProject, type ProjectRow } from '@/lib/chat/projects';
import type { WorkspaceGitAccess } from '@/lib/sandbox/workspace-git';
import { CLONE_IN_FLIGHT_MS, startProjectClone } from './projects';

const list = jest.mocked(sbWorkspaceList);
const remove = jest.mocked(sbWorkspaceDelete);
const clone = jest.mocked(sbWorkspaceClone);
const update = jest.mocked(updateProject);

const NOW = Date.parse('2026-11-27T19:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function project(workspaceId: string | null, branch = 'main'): ProjectRow {
  return {
    id: 'p1',
    ownerSubject: 'alice',
    name: 'PACE',
    description: null,
    sealedInstructions: null,
    toolConfig: null,
    kind: 'code',
    repo: { provider: 'atlassian-bitbucket', fullName: 'acme/pace', branch },
    workspaceId,
    llmModelId: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
}

const workspace = (
  id: string,
  status: 'cloning' | 'ready' | 'failed',
  extra: { parentId?: string; branch?: string; createdAt?: string } = {}
) => ({
  id,
  provider: 'atlassian-bitbucket',
  repoFullName: 'acme/pace',
  parentId: extra.parentId ?? null,
  branch: extra.branch ?? 'main',
  status,
  error: null,
  sizeBytes: 1,
  createdAt: extra.createdAt ?? ago(60 * 60_000),
  lastUsedAt: '',
  expiresAt: '',
  worker: null,
});

const credential: WorkspaceGitAccess = {
  gitProxy: {
    base: 'http://delegate:8096/git/t/bitbucket.org/',
    insteadOf: 'https://bitbucket.org/',
    expiresAt: '2030-01-01T00:00:00.000Z',
  },
  username: 'alice',
};
const deleted = () => remove.mock.calls.map((call) => call[1]).sort();

beforeEach(() => {
  jest.clearAllMocks();
  clone.mockResolvedValue({ ok: true, val: workspace('ws-new', 'cloning') });
});

describe('startProjectClone', () => {
  it('drops every clone the worker holds for the project, not only the one on the row, then clones', async () => {
    list.mockResolvedValue({
      ok: true,
      val: [
        workspace('ws-1', 'failed'),
        workspace('ws-orphan-a', 'ready'),
        workspace('ws-orphan-b', 'failed'),
        // A worktree goes with its clone on the worker; it is not a clone to drop here.
        workspace('wt-1', 'ready', { parentId: 'ws-1' }),
      ],
    });
    const outcome = await startProjectClone(project('ws-1'), credential, { now: NOW });
    expect(deleted()).toEqual(['ws-1', 'ws-orphan-a', 'ws-orphan-b']);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, val: { id: 'ws-new' } });
    expect(update).toHaveBeenLastCalledWith('p1', { workspaceId: 'ws-new' });
  });

  it('joins a clone of the same repository and branch another request just started', async () => {
    list.mockResolvedValue({
      ok: true,
      val: [
        workspace('ws-1', 'failed'),
        workspace('ws-theirs', 'cloning', { createdAt: ago(20_000) }),
      ],
    });
    const outcome = await startProjectClone(project('ws-1'), credential, { now: NOW });
    expect(clone).not.toHaveBeenCalled();
    expect(deleted()).toEqual(['ws-1']);
    expect(outcome).toMatchObject({ ok: true, val: { id: 'ws-theirs', status: 'cloning' } });
    expect(update).toHaveBeenLastCalledWith('p1', { workspaceId: 'ws-theirs' });
  });

  it('does not join a clone of another branch, or one its worker never finished', async () => {
    list.mockResolvedValue({
      ok: true,
      val: [
        workspace('ws-other-branch', 'cloning', { branch: 'develop', createdAt: ago(20_000) }),
        workspace('ws-stuck', 'cloning', { createdAt: ago(CLONE_IN_FLIGHT_MS + 1) }),
      ],
    });
    const outcome = await startProjectClone(project(null), credential, { now: NOW });
    expect(deleted()).toEqual(['ws-other-branch', 'ws-stuck']);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, val: { id: 'ws-new' } });
  });

  it('still drops the checkout on the row and clones when the worker cannot list', async () => {
    list.mockResolvedValue({ ok: false, err: { kind: 'unreachable', message: 'down' } });
    const outcome = await startProjectClone(project('ws-1'), credential, { now: NOW });
    expect(deleted()).toEqual(['ws-1']);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
  });

  it('says why when the worker refuses the clone, and leaves the row naming no checkout', async () => {
    list.mockResolvedValue({ ok: true, val: [workspace('ws-1', 'failed')] });
    clone.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'workspace_limit',
        message: 'At most 3 workspaces at once',
        status: 429,
      },
    });
    const outcome = await startProjectClone(project('ws-1'), credential, { now: NOW });
    expect(outcome).toEqual({ ok: false, status: 429, message: 'At most 3 workspaces at once' });
    expect(update).toHaveBeenLastCalledWith('p1', { workspaceId: null });
  });
});
