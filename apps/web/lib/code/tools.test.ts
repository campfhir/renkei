/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The code_* tools against a scripted worker client: every verb reaches
 * the worker under the PROJECT's target with the bound checkout (no
 * argument names a workspace), reads are marked read-only, a run's
 * answer carries the verdict and both streams (an error result on a
 * non-zero exit), a push spends the chatting person's own credential and
 * never echoes it, and a worker refusal becomes a clean error.
 */

jest.mock('@renkei/sandbox-client', () => ({
  clientFailure: jest.fn((error: { kind: string; type?: string; message?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type ?? error.kind}`,
  })),
  sbEnvList: jest.fn(),
  sbWorkspaceEdit: jest.fn(),
  sbWorkspaceExec: jest.fn(),
  sbWorkspaceFind: jest.fn(),
  sbWorkspaceGitCommit: jest.fn(),
  sbWorkspaceGitDiff: jest.fn(),
  sbWorkspaceGitPull: jest.fn(),
  sbWorkspaceGitPush: jest.fn(),
  sbWorkspaceGitStatus: jest.fn(),
  sbWorkspaceGrep: jest.fn(),
  sbWorkspaceLs: jest.fn(),
  sbWorkspaceRead: jest.fn(),
  sbWorkspaceWrite: jest.fn(),
}));

jest.mock('@/lib/sandbox/workspace-git', () => ({
  resolveWorkspaceGitCredential: jest.fn(),
  commitAuthorFor: (username: string, email?: string) => ({
    name: username,
    email: email ?? 'x@y',
  }),
}));

import {
  MAX_CHECKOUT_RECOVERIES_PER_TURN,
  codeTools,
  numberedLines,
  renderRun,
  type CheckoutRecovery,
} from './tools';
import type { LocalToolContext } from '@/lib/chat/local-tools';

const client = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');
const git = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/workspace-git');

const TARGET = { tenantId: 'tenant-1', subject: 'code-project:p1' };
const WS_ID = '11111111-1111-4111-8111-111111111111';
const context: LocalToolContext = {
  db: {} as LocalToolContext['db'],
  tenantId: 'tenant-1',
  subject: 'auth0|alice',
  chatId: 'chat-1',
  projectId: 'p1',
  userEmail: 'alice@example.com',
  readOnly: false,
};

function tools(recover?: (lostWorkspaceId: string) => Promise<CheckoutRecovery>) {
  const list = codeTools({
    target: TARGET,
    workspaceId: WS_ID,
    repoFullName: 'acme/demo',
    repoProvider: 'atlassian-bitbucket',
    origin: 'https://r.example',
    ...(recover ? { recover } : {}),
  });
  return new Map(list.map((tool) => [tool.def.name, tool]));
}

const NEW_WS_ID = '22222222-2222-4222-8222-222222222222';
const checkoutGone = {
  ok: false,
  err: {
    kind: 'op',
    type: 'not_ready',
    message: 'That workspace’s checkout is gone from the worker’s disk.',
    status: 409,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  // A clean working tree unless a test says otherwise.
  client.sbWorkspaceGitDiff.mockResolvedValue({
    ok: true,
    val: { branch: 'main', diff: '', files: [], truncated: false },
  });
});

describe('the set', () => {
  it('names every verb and marks the reads', () => {
    const set = tools();
    expect([...set.keys()].sort()).toEqual([
      'code_clone',
      'code_delegate',
      'code_edit_file',
      'code_env_names',
      'code_find',
      'code_git_commit',
      'code_git_pull',
      'code_git_push',
      'code_git_status',
      'code_grep',
      'code_ls',
      'code_read_file',
      'code_run',
      'code_write_file',
    ]);
    expect(set.get('code_grep')!.readOnly).toBe(true);
    expect(set.get('code_env_names')!.readOnly).toBe(true);
    expect(set.get('code_run')!.readOnly).toBeUndefined();
    expect(set.get('code_edit_file')!.readOnly).toBeUndefined();
  });
});

describe('a checkout lost mid-turn', () => {
  it('is brought back once and the call runs again in the new checkout, saying so', async () => {
    client.sbWorkspaceLs
      .mockResolvedValueOnce(checkoutGone)
      .mockResolvedValueOnce({
        ok: true,
        val: { path: '', entries: [{ path: 'README.md', kind: 'file', sizeBytes: 12 }] },
      });
    const recover = jest.fn(async (): Promise<CheckoutRecovery> => ({
      ok: true,
      workspaceId: NEW_WS_ID,
      seconds: 7,
      how: 'cloned',
    }));
    const set = tools(recover);
    const result = await set.get('code_ls')!.execute({}, context);
    expect(recover).toHaveBeenCalledWith(WS_ID);
    expect(client.sbWorkspaceLs).toHaveBeenNthCalledWith(1, TARGET, { id: WS_ID, path: '' });
    expect(client.sbWorkspaceLs).toHaveBeenNthCalledWith(2, TARGET, { id: NEW_WS_ID, path: '' });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe(
      '[The checkout had gone from the sandbox; it was cloned again (7s) and this call ran again in the new one.]\n\nREADME.md (12 B)'
    );
    // Every tool now works in the new checkout, with no further recovery.
    client.sbWorkspaceRead.mockResolvedValue({
      ok: true,
      val: { path: 'a', text: 'x', truncated: false, sizeBytes: 1 },
    });
    await set.get('code_read_file')!.execute({ path: 'a' }, context);
    expect(client.sbWorkspaceRead).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({ id: NEW_WS_ID })
    );
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('shares one recovery between reads that hit the wall together', async () => {
    client.sbWorkspaceLs
      .mockResolvedValueOnce(checkoutGone)
      .mockResolvedValue({ ok: true, val: { path: '', entries: [] } });
    client.sbWorkspaceGrep
      .mockResolvedValueOnce(checkoutGone)
      .mockResolvedValue({ ok: true, val: { matches: [], truncated: false } });
    let release: (value: CheckoutRecovery) => void = () => {};
    const recover = jest.fn(() => new Promise<CheckoutRecovery>((resolve) => (release = resolve)));
    const set = tools(recover);
    const both = Promise.all([
      set.get('code_ls')!.execute({}, context),
      set.get('code_grep')!.execute({ pattern: 'x' }, context),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release({ ok: true, workspaceId: NEW_WS_ID, seconds: 3, how: 'adopted' });
    const [ls, grep] = await both;
    expect(recover).toHaveBeenCalledTimes(1);
    expect(ls.isError).toBe(false);
    expect(grep.isError).toBe(false);
    expect(grep.content[0]!.text).toMatch(
      /^\[The checkout had been replaced by a newer clone \(3s\)/
    );
  });

  it('answers the worker’s error, with why, when the checkout cannot come back', async () => {
    client.sbWorkspaceLs.mockResolvedValue(checkoutGone);
    const recover = jest.fn(async (): Promise<CheckoutRecovery> => ({
      ok: false,
      message: 'Bitbucket is not connected.',
    }));
    const result = await tools(recover).get('code_ls')!.execute({}, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      'That workspace’s checkout is gone from the worker’s disk. Cloning it again did not work: Bitbucket is not connected.'
    );
  });

  it('stops trying past the per-turn limit and tells the model to stop', async () => {
    client.sbWorkspaceLs.mockResolvedValue(checkoutGone);
    const recover = jest.fn(async (): Promise<CheckoutRecovery> => ({
      ok: true,
      workspaceId: NEW_WS_ID,
      seconds: 1,
      how: 'cloned',
    }));
    const set = tools(recover);
    for (let attempt = 0; attempt < MAX_CHECKOUT_RECOVERIES_PER_TURN; attempt += 1) {
      const result = await set.get('code_ls')!.execute({}, context);
      // Recovered, but the retried call found it gone again.
      expect(result.isError).toBe(true);
    }
    expect(recover).toHaveBeenCalledTimes(MAX_CHECKOUT_RECOVERIES_PER_TURN);
    const refused = await set.get('code_run')!.execute({ command: 'true' }, context);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(
      /lost 2 times in this turn .* Stop and tell the person/
    );
    expect(client.sbWorkspaceExec).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledTimes(MAX_CHECKOUT_RECOVERIES_PER_TURN);
  });

  it('code_clone is a probe: present means nothing to do, gone means the wrapper brings it back', async () => {
    client.sbWorkspaceLs.mockResolvedValueOnce({
      ok: true,
      val: { path: '', entries: [{ path: 'README.md', kind: 'file', sizeBytes: 1 }] },
    });
    const recover = jest.fn(async (): Promise<CheckoutRecovery> => ({
      ok: true,
      workspaceId: NEW_WS_ID,
      seconds: 4,
      how: 'cloned',
    }));
    const set = tools(recover);
    const present = await set.get('code_clone')!.execute({}, context);
    expect(present.isError).toBe(false);
    expect(present.content[0]!.text).toMatch(/usable \(1 entries at its root\); nothing to clone/);
    expect(recover).not.toHaveBeenCalled();

    client.sbWorkspaceLs
      .mockResolvedValueOnce(checkoutGone)
      .mockResolvedValueOnce({ ok: true, val: { path: '', entries: [] } });
    const gone = await set.get('code_clone')!.execute({}, context);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(gone.isError).toBe(false);
    expect(gone.content[0]!.text).toMatch(
      /^\[The checkout had gone from the sandbox; it was cloned again \(4s\)/
    );
  });

  it('leaves a missing file alone: only a missing checkout is recovered', async () => {
    client.sbWorkspaceRead.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: 'No such file: nope.ts', status: 404 },
    });
    const recover = jest.fn();
    const result = await tools(recover)
      .get('code_read_file')!
      .execute({ path: 'nope.ts' }, context);
    expect(result.isError).toBe(true);
    expect(recover).not.toHaveBeenCalled();
  });

  it('without a way back, the worker’s error is the answer', async () => {
    client.sbWorkspaceLs.mockResolvedValue(checkoutGone);
    const result = await tools().get('code_ls')!.execute({}, context);
    expect(result.isError).toBe(true);
    expect(client.sbWorkspaceLs).toHaveBeenCalledTimes(1);
  });
});

describe('file changes carry their diff', () => {
  it('appends the file’s fenced diff to a write and counts changes after a run', async () => {
    client.sbWorkspaceWrite.mockResolvedValue({
      ok: true,
      val: { path: 'src/a.ts', created: false, sizeBytes: 20 },
    });
    client.sbWorkspaceGitDiff.mockResolvedValue({
      ok: true,
      val: {
        branch: 'main',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n',
        files: [{ path: 'src/a.ts', added: 1, deleted: 1, status: 'modified' }],
        truncated: false,
      },
    });
    const written = await tools()
      .get('code_write_file')!
      .execute({ path: 'src/a.ts', content: 'y\n' }, context);
    expect(client.sbWorkspaceGitDiff).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      paths: ['src/a.ts'],
    });
    expect(written.content[0]!.text).toBe(
      'Replaced src/a.ts (20 B).\n\n```diff\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n\n```'
    );
    client.sbWorkspaceExec.mockResolvedValue({
      ok: true,
      val: {
        exitCode: 0,
        signal: null,
        stdout: 'ok\n',
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 100,
        timeoutMs: 120_000,
        sizeBytes: 10,
        unreadableEnv: [],
      },
    });
    const ran = await tools().get('code_run')!.execute({ command: 'make' }, context);
    expect(client.sbWorkspaceGitDiff).toHaveBeenLastCalledWith(TARGET, {
      id: WS_ID,
      statOnly: true,
    });
    expect(ran.content[0]!.text).toContain(
      '--- working tree (uncommitted changes) ---\n  +1 −1 src/a.ts'
    );
  });
});

describe('code_run', () => {
  it('reaches the worker under the project target and answers both streams', async () => {
    client.sbWorkspaceExec.mockResolvedValue({
      ok: true,
      val: {
        exitCode: 1,
        signal: null,
        stdout: 'ran 3 tests\n',
        stderr: 'FAIL src/a.test.ts\n',
        timedOut: false,
        truncated: false,
        durationMs: 1500,
        timeoutMs: 120_000,
        sizeBytes: 10,
        unreadableEnv: [],
      },
    });
    const result = await tools().get('code_run')!.execute({ command: 'pnpm test' }, context);
    expect(client.sbWorkspaceExec).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      command: 'pnpm test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'exit 1 (1.5s)\n--- stdout ---\nran 3 tests\n--- stderr ---\nFAIL src/a.test.ts',
    });
  });

  it('refuses under read-only mode before any call', async () => {
    const result = await tools()
      .get('code_run')!
      .execute({ command: 'ls' }, { ...context, readOnly: true });
    expect(result.isError).toBe(true);
    expect(client.sbWorkspaceExec).not.toHaveBeenCalled();
  });

  it('renders a timeout and the unreadable variables', () => {
    const rendered = renderRun(
      {
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        timedOut: true,
        truncated: false,
        durationMs: 30_000,
        timeoutMs: 30_000,
        unreadableEnv: ['NPM_TOKEN'],
      },
      1_000
    );
    expect(rendered.ok).toBe(false);
    expect(rendered.text).toContain('TIMED OUT after 30s');
    expect(rendered.text).toContain('NPM_TOKEN');
  });
});

describe('files', () => {
  it('numbers the lines of a read', async () => {
    client.sbWorkspaceRead.mockResolvedValue({
      ok: true,
      val: {
        path: 'src/a.ts',
        text: 'one\ntwo',
        sizeBytes: 8,
        totalLines: 40,
        startLine: 9,
        endLine: 10,
      },
    });
    const result = await tools()
      .get('code_read_file')!
      .execute({ path: 'src/a.ts', startLine: 9, maxLines: 2 }, context);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'src/a.ts — lines 9-10 of 40 (8 B)\n 9\tone\n10\ttwo',
    });
    expect(numberedLines('a\nb', 1)).toBe('1\ta\n2\tb');
  });

  it('turns a worker refusal into a clean error', async () => {
    client.sbWorkspaceEdit.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'edit_conflict', message: 'oldText occurs 2 times', status: 409 },
    });
    const result = await tools()
      .get('code_edit_file')!
      .execute({ path: 'a', oldText: 'x', newText: 'y' }, context);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'oldText occurs 2 times' }],
      isError: true,
      meta: {},
    });
  });
});

describe('git', () => {
  it('pushes with the person’s own write credential and never echoes it', async () => {
    git.resolveWorkspaceGitCredential.mockResolvedValue({
      authHeader: 'Basic c2VjcmV0',
      username: 'alice',
    });
    client.sbWorkspaceGitPush.mockResolvedValue({
      ok: true,
      val: { branch: 'fix', remoteBranch: 'fix', output: '' },
    });
    const result = await tools().get('code_git_push')!.execute({}, context);
    expect(git.resolveWorkspaceGitCredential).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        subject: 'auth0|alice',
        origin: 'https://r.example',
        provider: 'atlassian-bitbucket',
      },
      { write: true }
    );
    expect(client.sbWorkspaceGitPush).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      authHeader: 'Basic c2VjcmV0',
    });
    expect(result.content[0].type === 'text' && result.content[0].text).not.toContain('c2VjcmV0');
    expect(result.content[0].type === 'text' && result.content[0].text).toContain('acme/demo');
  });

  it('commits as the person, on a new branch when asked', async () => {
    git.resolveWorkspaceGitCredential.mockResolvedValue({
      authHeader: 'Basic r',
      username: 'alice',
    });
    client.sbWorkspaceGitCommit.mockResolvedValue({
      ok: true,
      val: { branch: 'fix', commit: 'abc123 Fix it' },
    });
    const result = await tools()
      .get('code_git_commit')!
      .execute({ message: 'Fix it', newBranch: 'fix' }, context);
    expect(client.sbWorkspaceGitCommit).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      message: 'Fix it',
      newBranch: 'fix',
      author: { name: 'alice', email: 'alice@example.com' },
    });
    expect(result.content[0]).toEqual({ type: 'text', text: 'Committed on fix: abc123 Fix it' });
  });

  it('refuses a push the grant cannot cover', async () => {
    git.resolveWorkspaceGitCredential.mockResolvedValue('Bitbucket is not connected.');
    const result = await tools().get('code_git_push')!.execute({}, context);
    expect(result.isError).toBe(true);
    expect(client.sbWorkspaceGitPush).not.toHaveBeenCalled();
  });
});
