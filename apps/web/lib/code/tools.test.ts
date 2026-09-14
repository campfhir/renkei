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

import { codeTools, numberedLines, renderRun } from './tools';
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

function tools() {
  const list = codeTools({
    target: TARGET,
    workspaceId: WS_ID,
    repoFullName: 'acme/demo',
    origin: 'https://r.example',
  });
  return new Map(list.map((tool) => [tool.def.name, tool]));
}

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
      { tenantId: 'tenant-1', subject: 'auth0|alice', origin: 'https://r.example' },
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
