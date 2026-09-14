/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The sandbox_workspace_* tools against a scripted worker client: they
 * register only where the deployment enables workspaces, the git verbs
 * only for a caller who may reach Bitbucket, a run's answer carries the
 * exit code and both streams (an error result on a non-zero exit), a
 * read is line-numbered, and a worker refusal becomes a clean errText().
 */

jest.mock('@/lib/sandbox/service-client', () => ({
  sandboxConfig: jest.fn(() => ({ url: 'http://sandbox.internal:8092', key: 'k' })),
  sandboxBrowserEnabled: jest.fn(() => false),
  sandboxWorkspacesEnabled: jest.fn(() => true),
  clientFailure: jest.fn((error: { kind: string; type?: string; message?: string }) => ({
    status: 400,
    message: error.message ?? `failed: ${error.type ?? error.kind}`,
  })),
  sbWorkspaceList: jest.fn(),
  sbWorkspaceClone: jest.fn(),
  sbWorkspaceDelete: jest.fn(),
  sbWorkspaceLs: jest.fn(),
  sbWorkspaceFind: jest.fn(),
  sbWorkspaceGrep: jest.fn(),
  sbWorkspaceRead: jest.fn(),
  sbWorkspaceWrite: jest.fn(),
  sbWorkspaceEdit: jest.fn(),
  sbWorkspaceExec: jest.fn(),
  sbWorkspaceGitStatus: jest.fn(),
  sbWorkspaceGitCommit: jest.fn(),
  sbWorkspaceGitPush: jest.fn(),
  sbWorkspaceGitPull: jest.fn(),
  sbEnvList: jest.fn(),
  sbFetchUrl: jest.fn(),
  sbListFiles: jest.fn(),
  sbStatFile: jest.fn(),
  sbReadFile: jest.fn(),
  sbWriteFile: jest.fn(),
  sbDeleteFile: jest.fn(),
}));

jest.mock('@/lib/sandbox/workspace-git', () => ({
  resolveWorkspaceGitCredential: jest.fn(),
  bitbucketCloneUrl: (workspace: string, repo: string) =>
    `https://bitbucket.org/${workspace}/${repo}.git`,
  commitAuthorFor: (username: string, email?: string) => ({
    name: username,
    email: email ?? 'x@y',
  }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerSandboxTools } from './index';
import type { MCPToolContext } from '../common';

const client = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/service-client');
const git = jest.requireMock<Record<string, jest.Mock>>('@/lib/sandbox/workspace-git');

type Handler = (
  args: Record<string, unknown>
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface Registered {
  config: { annotations?: { readOnlyHint?: boolean } };
  handler: Handler;
}

function collect(context: MCPToolContext, bitbucketGit = true): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Handler) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerSandboxTools(server, context, { workspaces: { bitbucketGit } });
  return tools;
}

const context = (subject = 'auth0|alice'): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject,
    origin: 'https://renkei.example',
    userEmail: 'alice@example.com',
  }) as unknown as MCPToolContext;

const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice' };
const WS_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  client.sandboxWorkspacesEnabled.mockReturnValue(true);
});

describe('registration', () => {
  it('offers the workspace verbs, and the git verbs only with Bitbucket', () => {
    const withGit = collect(context());
    expect(
      [...withGit.keys()].filter((name) => name.startsWith('sandbox_workspace_')).sort()
    ).toEqual([
      'sandbox_workspace_clone',
      'sandbox_workspace_delete',
      'sandbox_workspace_edit_file',
      'sandbox_workspace_find',
      'sandbox_workspace_git_commit',
      'sandbox_workspace_git_pull',
      'sandbox_workspace_git_push',
      'sandbox_workspace_git_status',
      'sandbox_workspace_grep',
      'sandbox_workspace_list',
      'sandbox_workspace_list_env',
      'sandbox_workspace_ls',
      'sandbox_workspace_read_file',
      'sandbox_workspace_run',
      'sandbox_workspace_write_file',
    ]);
    const without = collect(context(), false);
    expect(without.has('sandbox_workspace_clone')).toBe(false);
    expect(without.has('sandbox_workspace_git_push')).toBe(false);
    expect(without.has('sandbox_workspace_git_pull')).toBe(false);
    expect(without.has('sandbox_workspace_run')).toBe(true);
  });

  it('marks reads and acts', () => {
    const tools = collect(context());
    expect(tools.get('sandbox_workspace_grep')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('sandbox_workspace_list_env')!.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('sandbox_workspace_run')!.config.annotations?.readOnlyHint).toBe(false);
    expect(tools.get('sandbox_workspace_edit_file')!.config.annotations?.readOnlyHint).toBe(false);
  });

  it('registers nothing when workspaces are off', () => {
    client.sandboxWorkspacesEnabled.mockReturnValue(false);
    const tools = collect(context());
    expect([...tools.keys()].some((name) => name.startsWith('sandbox_workspace_'))).toBe(false);
  });
});

describe('sandbox_workspace_run', () => {
  it('answers exit code and both streams, as an error when the command failed', async () => {
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
    const tools = collect(context());
    const result = await tools
      .get('sandbox_workspace_run')!
      .handler({ workspaceId: WS_ID, command: 'pnpm test' });
    expect(client.sbWorkspaceExec).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      command: 'pnpm test',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'exit 1 (1.5s)\n--- stdout ---\nran 3 tests\n--- stderr ---\nFAIL src/a.test.ts'
    );
  });

  it('says when a command timed out and passes the timeout through', async () => {
    client.sbWorkspaceExec.mockResolvedValue({
      ok: true,
      val: {
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        timedOut: true,
        truncated: false,
        durationMs: 30_000,
        timeoutMs: 30_000,
        sizeBytes: 10,
        unreadableEnv: ['NPM_TOKEN'],
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_workspace_run')!
      .handler({ workspaceId: WS_ID, command: 'sleep 99', timeoutSeconds: 30 });
    expect(client.sbWorkspaceExec).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      command: 'sleep 99',
      timeoutMs: 30_000,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TIMED OUT after 30s');
    expect(result.content[0].text).toContain('NPM_TOKEN');
  });

  it('refuses a caller with no identity before any call', async () => {
    const tools = collect(context(''));
    const result = await tools
      .get('sandbox_workspace_run')!
      .handler({ workspaceId: WS_ID, command: 'ls' });
    expect(result.isError).toBe(true);
    expect(client.sbWorkspaceExec).not.toHaveBeenCalled();
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
    const tools = collect(context());
    const result = await tools
      .get('sandbox_workspace_read_file')!
      .handler({ workspaceId: WS_ID, path: 'src/a.ts', startLine: 9, maxLines: 2 });
    expect(result.content[0].text).toBe('src/a.ts — lines 9-10 of 40 (8 B)\n 9\tone\n10\ttwo');
  });

  it('turns a worker refusal into a clean error', async () => {
    client.sbWorkspaceEdit.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'edit_conflict', message: 'oldText occurs 2 times', status: 409 },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_workspace_edit_file')!
      .handler({ workspaceId: WS_ID, path: 'a', oldText: 'x', newText: 'y' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'oldText occurs 2 times' }],
      isError: true,
    });
  });
});

describe('git', () => {
  it('clones with a credential from the grant and never echoes it', async () => {
    git.resolveWorkspaceGitCredential.mockResolvedValue({
      authHeader: 'Basic c2VjcmV0',
      username: 'alice',
    });
    client.sbWorkspaceClone.mockResolvedValue({
      ok: true,
      val: {
        id: WS_ID,
        provider: 'atlassian-bitbucket',
        repoFullName: 'acme/demo',
        branch: '(default)',
        status: 'cloning',
        error: null,
        sizeBytes: 0,
        createdAt: '',
        lastUsedAt: '',
        expiresAt: '',
      },
    });
    const tools = collect(context());
    const result = await tools
      .get('sandbox_workspace_clone')!
      .handler({ repository: 'acme/demo', branch: 'main' });
    expect(git.resolveWorkspaceGitCredential).toHaveBeenCalledWith(
      expect.objectContaining(TARGET),
      { write: false }
    );
    expect(client.sbWorkspaceClone).toHaveBeenCalledWith(TARGET, {
      provider: 'atlassian-bitbucket',
      repoFullName: 'acme/demo',
      branch: 'main',
      cloneUrl: 'https://bitbucket.org/acme/demo.git',
      authHeader: 'Basic c2VjcmV0',
    });
    expect(result.content[0].text).toContain(WS_ID);
    expect(result.content[0].text).not.toContain('c2VjcmV0');
  });

  it('refuses a clone the grant cannot cover', async () => {
    git.resolveWorkspaceGitCredential.mockResolvedValue('Bitbucket is not connected.');
    const tools = collect(context());
    const result = await tools.get('sandbox_workspace_clone')!.handler({ repository: 'acme/demo' });
    expect(result.isError).toBe(true);
    expect(client.sbWorkspaceClone).not.toHaveBeenCalled();
  });

  it('asks for write access to push and commits as the person', async () => {
    git.resolveWorkspaceGitCredential.mockResolvedValue({
      authHeader: 'Basic w',
      username: 'alice',
    });
    client.sbWorkspaceGitPush.mockResolvedValue({
      ok: true,
      val: { branch: 'fix', remoteBranch: 'fix', output: '' },
    });
    client.sbWorkspaceGitCommit.mockResolvedValue({
      ok: true,
      val: { branch: 'fix', commit: 'abc123 Fix it' },
    });
    const tools = collect(context());
    await tools.get('sandbox_workspace_git_push')!.handler({ workspaceId: WS_ID });
    expect(git.resolveWorkspaceGitCredential).toHaveBeenCalledWith(expect.anything(), {
      write: true,
    });
    const committed = await tools
      .get('sandbox_workspace_git_commit')!
      .handler({ workspaceId: WS_ID, message: 'Fix it', newBranch: 'fix' });
    expect(client.sbWorkspaceGitCommit).toHaveBeenCalledWith(TARGET, {
      id: WS_ID,
      message: 'Fix it',
      newBranch: 'fix',
      author: { name: 'auth0|alice', email: 'alice@example.com' },
    });
    expect(committed.content[0].text).toBe('Committed on fix: abc123 Fix it');
  });
});
