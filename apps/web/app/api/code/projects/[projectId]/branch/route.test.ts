/**
 * Switching a checkout's branch, with the sandbox worker answered by a
 * double: when the switch is refused before anything is fetched (a turn
 * running, uncommitted changes), and that a clean checkout — whose
 * status from git still names its branch — is switched. The dialog's own
 * rules are app/(app)/code/_components/branch-switcher.model.test.ts.
 */

jest.mock('@/lib/code/route-access', () => ({ codeProjectContext: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/chat/turns', () => ({ getActiveTurn: jest.fn() }));
jest.mock('@/lib/get-origin', () => ({
  getOrigin: jest.fn(async () => ({ ok: true, val: 'http://test.local' })),
}));
jest.mock('@/lib/sandbox/workspace-git', () => ({ resolveWorkspaceGitAccess: jest.fn() }));
jest.mock('@/lib/code/repo-host', () => ({ hostAdapterFor: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  sbWorkspaceGitStatus: jest.fn(),
  sbWorkspaceGitPull: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const access = jest.requireMock<{ codeProjectContext: jest.Mock }>('@/lib/code/route-access');
const turns = jest.requireMock<{ getActiveTurn: jest.Mock }>('@/lib/chat/turns');
const git = jest.requireMock<{ resolveWorkspaceGitAccess: jest.Mock }>(
  '@/lib/sandbox/workspace-git'
);
const sandbox = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');
const { workingTreeChanges } =
  jest.requireActual<typeof import('@renkei/sandbox-client')>('@renkei/sandbox-client');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const PROJECT = 'project-1';
const params = { params: Promise.resolve({ projectId: PROJECT, chatId: 'chat-1' }) };

/** The checkout's status as the worker reports it: `git status --porcelain=v1 --branch`. */
function statusIs(text: string) {
  sandbox.sbWorkspaceGitStatus.mockResolvedValue({
    ok: true,
    val: {
      branch: 'main',
      status: text,
      changes: workingTreeChanges(text),
      inProgress: null,
      conflicts: [],
    },
  });
}

const switchTo = (branch: unknown) =>
  POST(
    new NextRequest(`http://test.local/api/code/projects/${PROJECT}/chats/chat-1/branch`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
    }),
    params
  );

beforeEach(() => {
  jest.clearAllMocks();
  access.codeProjectContext.mockResolvedValue({
    ok: true,
    context: {
      session: { subject: 'me@example.com', roles: ['renkei-user'] },
      access: { role: 'owner' },
      project: {
        id: PROJECT,
        name: 'Billing',
        repo: { provider: 'github', fullName: 'acme/billing', branch: 'main' },
      },
      workspaceId: 'ws-1',
      chat: { id: 'chat-1' },
    },
  });
  turns.getActiveTurn.mockResolvedValue(null);
  git.resolveWorkspaceGitAccess.mockResolvedValue({ gitProxy: { base: 'b', insteadOf: 'i' } });
  sandbox.sbWorkspaceGitPull.mockResolvedValue({
    ok: true,
    val: { branch: 'feature/x', output: '' },
  });
  statusIs('## main...origin/main\n');
});

describe('switching branch', () => {
  it('a clean checkout is switched: git’s status names the branch even when nothing has changed', async () => {
    const response = await switchTo('feature/x');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ branch: 'feature/x' });
    expect(sandbox.sbWorkspaceGitPull).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'ws-1', branch: 'feature/x' })
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'code.branch_switch' })
    );
  });

  it('a checkout with uncommitted changes is refused, for the dialog to offer discarding them', async () => {
    statusIs('## main...origin/main\n M src/billing.ts\n?? notes.md\n');
    const response = await switchTo('feature/x');
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('dirty');
    expect(sandbox.sbWorkspaceGitPull).not.toHaveBeenCalled();
  });

  it('a chat mid-turn is refused before the checkout is even looked at', async () => {
    turns.getActiveTurn.mockResolvedValue({ id: 'turn-1' });
    const response = await switchTo('feature/x');
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('turn-running');
    expect(sandbox.sbWorkspaceGitStatus).not.toHaveBeenCalled();
  });

  it('what git refuses is passed on with its own words', async () => {
    sandbox.sbWorkspaceGitPull.mockResolvedValue({
      ok: false,
      err: {
        kind: 'op',
        type: 'git_failed',
        status: 409,
        message: "fatal: 'main' is already used by worktree at '/workspaces/x/base'",
      },
    });
    const response = await switchTo('main');
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('switch');
  });

  it.each([
    ['no branch', ''],
    ['a name git would not take', 'bad..name'],
  ])('%s is refused outright', async (_name, branch) => {
    expect((await switchTo(branch)).status).toBe(400);
    expect(sandbox.sbWorkspaceGitStatus).not.toHaveBeenCalled();
  });

  it('a project with no checkout has nothing to switch', async () => {
    access.codeProjectContext.mockResolvedValue({
      ok: true,
      context: {
        session: { subject: 'me@example.com' },
        access: { role: 'owner' },
        project: { id: PROJECT, name: 'Billing', repo: { provider: 'github', fullName: 'a/b' } },
        workspaceId: null,
        chat: null,
      },
    });
    const response = await switchTo('feature/x');
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('not-cloned');
  });
});
