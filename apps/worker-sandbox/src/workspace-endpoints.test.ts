/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any */
/**
 * The workspace verbs over the wire: closed when not enabled, scoped to
 * the caller's own row, a credential never echoed, and — the property the
 * feature stands on — a secret's value masked out of a command's output
 * and a file's contents alike. Stores are mocked; the checkout is a real
 * temporary directory.
 */

jest.mock('./workspace-store', () => ({
  getWorkspace: jest.fn(),
  listWorkspaces: jest.fn(),
  countWorkspaces: jest.fn(),
  insertWorkspace: jest.fn(),
  setWorkspaceStatus: jest.fn(),
  touchWorkspace: jest.fn(),
  deleteWorkspace: jest.fn(),
  listExpiredWorkspaces: jest.fn(),
  deleteWorkspaceById: jest.fn(),
}));

jest.mock('./env-secrets-store', () => ({
  listSealedEnv: jest.fn(),
  touchEnvSecretsUsed: jest.fn(),
  listEnvSecrets: jest.fn(),
  countEnvSecrets: jest.fn(),
  hasEnvSecret: jest.fn(),
  upsertEnvSecret: jest.fn(),
  deleteEnvSecret: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { createSandboxServer } from './server';
import { createWorkspaceHandlers } from './workspace-endpoints';
import {
  ORPHAN_GRACE_MS,
  identityFor,
  setWorkspacesRootForTests,
  workspaceDir,
} from './workspaces';
import { resetEnvSecretsKeyForTests, sealEnvValue, envSecretsKey } from './env-secrets';

const workspaceStore = jest.requireMock<Record<string, jest.Mock>>('./workspace-store');
const envStore = jest.requireMock<Record<string, jest.Mock>>('./env-secrets-store');

const API_KEY = 'test-worker-key';
const TARGET = { tenantId: 'tenant-1', subject: 'alice' };
const STORAGE_KEY = 'tenant-1/hash/ws-1';

let root: string;
let enabledServer: Server;
let disabledServer: Server;
let enabledBase: string;
let disabledBase: string;

function readyWorkspace() {
  return {
    id: 'ws-1',
    tenantId: 'tenant-1',
    subject: 'alice',
    provider: 'atlassian-bitbucket',
    repoFullName: 'acme/demo',
    branch: 'main',
    storageKey: STORAGE_KEY,
    status: 'ready',
    error: null,
    sizeBytes: 10,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(
  base: string,
  op: string,
  body: unknown
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  process.env.SANDBOX_ENV_SECRETS_KEY = Buffer.alloc(32, 3).toString('base64');
  resetEnvSecretsKeyForTests();
  root = await mkdtemp(join(tmpdir(), 'renkei-wse-'));
  setWorkspacesRootForTests(root);
  const dir = workspaceDir(STORAGE_KEY);
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(root, 'tenant-1', 'hash', 'home'), { recursive: true });
  await writeFile(join(dir, 'src', 'config.ts'), 'export const token = "tok-abc123";\n');
  enabledServer = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    workspaces: true,
  });
  disabledServer = createSandboxServer({ db: {} as Kysely<DB>, apiKeys: [API_KEY] });
  enabledBase = await listen(enabledServer);
  disabledBase = await listen(disabledServer);
});

afterAll(async () => {
  await new Promise((resolve) => enabledServer.close(resolve));
  await new Promise((resolve) => disabledServer.close(resolve));
  await rm(root, { recursive: true, force: true });
  delete process.env.SANDBOX_ENV_SECRETS_KEY;
  resetEnvSecretsKeyForTests();
});

beforeEach(() => {
  jest.clearAllMocks();
  workspaceStore.getWorkspace.mockImplementation(
    async (_db: unknown, target: { subject: string }, id: string) =>
      target.subject === 'alice' && id === 'ws-1' ? readyWorkspace() : undefined
  );
  workspaceStore.touchWorkspace.mockResolvedValue(undefined);
  envStore.touchEnvSecretsUsed.mockResolvedValue(undefined);
  envStore.listSealedEnv.mockResolvedValue([
    { id: 'e1', name: 'NPM_TOKEN', sealed: sealEnvValue('tok-abc123', envSecretsKey()!) },
  ]);
});

describe('when workspaces are not enabled', () => {
  it('answers every workspace and env verb 503', async () => {
    expect((await post(disabledBase, 'workspaces/list', TARGET)).status).toBe(503);
    expect((await post(disabledBase, 'env/list', TARGET)).status).toBe(503);
  });
});

describe('scope', () => {
  it('does not find another caller’s workspace', async () => {
    const result = await post(enabledBase, 'workspaces/read', {
      tenantId: 'tenant-1',
      subject: 'mallory',
      id: 'ws-1',
      path: 'src/config.ts',
    });
    expect(result.status).toBe(404);
  });

  it('refuses a path outside the checkout', async () => {
    const result = await post(enabledBase, 'workspaces/read', {
      ...TARGET,
      id: 'ws-1',
      path: '../../etc/passwd',
    });
    expect(result.status).toBe(400);
    expect(result.json.error.type).toBe('bad_path');
  });
});

describe('a checkout that vanished from disk', () => {
  it('marks the workspace failed and says to clone again, on any verb', async () => {
    workspaceStore.getWorkspace.mockImplementation(
      async (_db: unknown, target: { subject: string }, id: string) =>
        target.subject === 'alice' && id === 'ws-gone'
          ? { ...readyWorkspace(), id: 'ws-gone', storageKey: 'tenant-1/hash/ws-gone' }
          : undefined
    );
    workspaceStore.setWorkspaceStatus.mockResolvedValue(undefined);
    for (const op of ['workspaces/git-status', 'workspaces/exec']) {
      const result = await post(enabledBase, op, { ...TARGET, id: 'ws-gone', command: 'true' });
      expect(result.status).toBe(409);
      expect(result.json.error.type).toBe('not_ready');
      expect(result.json.error.message).toMatch(/checkout is gone .*clones the repository again/);
      // The caller's directory (tenant-1/hash) is there: only this checkout was removed.
      expect(result.json.error.message).toMatch(
        /checkout alone was removed \(worker \S+, up \S+\)/
      );
    }
    expect(workspaceStore.setWorkspaceStatus).toHaveBeenCalledWith(
      expect.anything(),
      'ws-gone',
      'failed',
      { error: expect.stringContaining('no longer on the worker') }
    );
  });

  it('says when this worker never had the project at all', async () => {
    workspaceStore.getWorkspace.mockImplementation(
      async (_db: unknown, target: { subject: string }, id: string) =>
        target.subject === 'alice' && id === 'ws-elsewhere'
          ? { ...readyWorkspace(), id: 'ws-elsewhere', storageKey: 'tenant-1/other-hash/ws-1' }
          : undefined
    );
    workspaceStore.setWorkspaceStatus.mockResolvedValue(undefined);
    const result = await post(enabledBase, 'workspaces/ls', { ...TARGET, id: 'ws-elsewhere' });
    expect(result.status).toBe(409);
    expect(result.json.error.message).toMatch(
      /no files for this project at all.*second worker instance behind the same address/
    );
  });

  it('names the worker that answers, on every workspace it describes', async () => {
    const result = await post(enabledBase, 'workspaces/get', { ...TARGET, id: 'ws-1' });
    expect(result.status).toBe(200);
    expect(result.json.workspace.worker).toEqual(expect.any(String));
    expect(result.json.workspace.worker).not.toBe('');
  });
});

describe('the sweep across instances', () => {
  it('removes only what is on this disk, leaves a fresh row for its own instance, drops an orphan', async () => {
    const here = 'tenant-1/hash/ws-expired-here';
    await mkdir(join(workspaceDir(here), 'src'), { recursive: true });
    const expired = (id: string, storageKey: string, expiredAgoMs: number) => ({
      ...readyWorkspace(),
      id,
      storageKey,
      expiresAt: new Date(Date.now() - expiredAgoMs),
    });
    workspaceStore.listExpiredWorkspaces.mockResolvedValue([
      expired('ws-expired-here', here, 60_000),
      expired('ws-elsewhere-fresh', 'tenant-1/hash/ws-elsewhere-fresh', 60_000),
      expired('ws-elsewhere-orphan', 'tenant-1/hash/ws-elsewhere-orphan', ORPHAN_GRACE_MS + 60_000),
    ]);
    workspaceStore.deleteWorkspaceById.mockResolvedValue(undefined);
    await createWorkspaceHandlers({ db: {} as Kysely<DB>, enabled: true }).sweep(10);
    const deleted = workspaceStore.deleteWorkspaceById.mock.calls.map((call) => call[1]);
    expect(deleted.sort()).toEqual(['ws-elsewhere-orphan', 'ws-expired-here']);
    await expect(readFile(join(workspaceDir(here), 'src'))).rejects.toThrow();
  });
});

describe('secrets never leave as text', () => {
  it('masks a value a command prints', async () => {
    const result = await post(enabledBase, 'workspaces/exec', {
      ...TARGET,
      id: 'ws-1',
      command: 'echo "token is $NPM_TOKEN"; echo "$NPM_TOKEN" >&2',
    });
    expect(result.status).toBe(200);
    expect(result.json.exitCode).toBe(0);
    expect(result.json.stdout).toBe('token is ••••••\n');
    expect(result.json.stderr).toBe('••••••\n');
    expect(envStore.touchEnvSecretsUsed).toHaveBeenCalledWith(expect.anything(), ['e1']);
  });

  it('masks a value sitting in a file and in a grep match', async () => {
    const read = await post(enabledBase, 'workspaces/read', {
      ...TARGET,
      id: 'ws-1',
      path: 'src/config.ts',
    });
    expect(read.status).toBe(200);
    expect(read.json.text).toBe('export const token = "••••••";\n');
    expect(read.json.totalLines).toBe(2);
    const grep = await post(enabledBase, 'workspaces/grep', {
      ...TARGET,
      id: 'ws-1',
      pattern: 'token',
    });
    expect(grep.status).toBe(200);
    expect(grep.json.matches[0].text).toBe('export const token = "••••••";');
  });
});

describe('editing', () => {
  it('replaces exactly one occurrence and reports ambiguity', async () => {
    await writeFile(join(workspaceDir(STORAGE_KEY), 'a.txt'), 'one two one\n');
    const ambiguous = await post(enabledBase, 'workspaces/edit', {
      ...TARGET,
      id: 'ws-1',
      path: 'a.txt',
      oldText: 'one',
      newText: 'uno',
    });
    expect(ambiguous.status).toBe(409);
    const edited = await post(enabledBase, 'workspaces/edit', {
      ...TARGET,
      id: 'ws-1',
      path: 'a.txt',
      oldText: 'two',
      newText: 'dos',
    });
    expect(edited.status).toBe(200);
    const read = await post(enabledBase, 'workspaces/read', {
      ...TARGET,
      id: 'ws-1',
      path: 'a.txt',
    });
    expect(read.json.text).toBe('one dos one\n');
    expect(
      (
        await post(enabledBase, 'workspaces/write', {
          ...TARGET,
          id: 'ws-1',
          path: '.git/config',
          content: 'x',
        })
      ).status
    ).toBe(400);
  });
});

describe('removing and renaming', () => {
  it('removes a file, then answers 404 for a second removal', async () => {
    await writeFile(join(workspaceDir(STORAGE_KEY), 'gone.txt'), 'bye\n');
    const removed = await post(enabledBase, 'workspaces/rm', {
      ...TARGET,
      id: 'ws-1',
      path: 'gone.txt',
    });
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual({ path: 'gone.txt', deleted: true });
    const again = await post(enabledBase, 'workspaces/rm', {
      ...TARGET,
      id: 'ws-1',
      path: 'gone.txt',
    });
    expect(again.status).toBe(404);
  });

  it('refuses to remove .git', async () => {
    const result = await post(enabledBase, 'workspaces/rm', {
      ...TARGET,
      id: 'ws-1',
      path: '.git/config',
    });
    expect(result.status).toBe(400);
  });

  it('renames a file into a new folder', async () => {
    await writeFile(join(workspaceDir(STORAGE_KEY), 'before.txt'), 'stays the same\n');
    const moved = await post(enabledBase, 'workspaces/mv', {
      ...TARGET,
      id: 'ws-1',
      from: 'before.txt',
      to: 'moved/after.txt',
    });
    expect(moved.status).toBe(200);
    expect(moved.json).toEqual({ from: 'before.txt', to: 'moved/after.txt' });
    const read = await post(enabledBase, 'workspaces/read', {
      ...TARGET,
      id: 'ws-1',
      path: 'moved/after.txt',
    });
    expect(read.json.text).toBe('stays the same\n');
  });

  it('refuses to rename onto an existing file', async () => {
    await writeFile(join(workspaceDir(STORAGE_KEY), 'one.txt'), '1\n');
    await writeFile(join(workspaceDir(STORAGE_KEY), 'two.txt'), '2\n');
    const result = await post(enabledBase, 'workspaces/mv', {
      ...TARGET,
      id: 'ws-1',
      from: 'one.txt',
      to: 'two.txt',
    });
    expect(result.status).toBe(409);
  });

  it('creates a folder with mkdir -p semantics, idempotent on a second call', async () => {
    const made = await post(enabledBase, 'workspaces/mkdir', {
      ...TARGET,
      id: 'ws-1',
      path: 'some_dir/some_other_dir',
    });
    expect(made.status).toBe(200);
    expect(made.json).toEqual({ path: 'some_dir/some_other_dir', created: true });
    const listed = await post(enabledBase, 'workspaces/ls', {
      ...TARGET,
      id: 'ws-1',
      path: 'some_dir',
    });
    expect(listed.json.entries).toContainEqual(
      expect.objectContaining({ path: 'some_dir/some_other_dir', kind: 'dir' })
    );
    const again = await post(enabledBase, 'workspaces/mkdir', {
      ...TARGET,
      id: 'ws-1',
      path: 'some_dir/some_other_dir',
    });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ path: 'some_dir/some_other_dir', created: false });
  });

  it('refuses a folder path that traverses outside the workspace', async () => {
    const result = await post(enabledBase, 'workspaces/mkdir', {
      ...TARGET,
      id: 'ws-1',
      path: '../escape',
    });
    expect(result.status).toBe(400);
    expect(result.json.error.type).toBe('bad_path');
  });

  it('refuses to create a folder where a file already exists', async () => {
    await writeFile(join(workspaceDir(STORAGE_KEY), 'already-a-file.txt'), 'x\n');
    const result = await post(enabledBase, 'workspaces/mkdir', {
      ...TARGET,
      id: 'ws-1',
      path: 'already-a-file.txt',
    });
    expect(result.status).toBe(409);
  });
});

describe('git-diff', () => {
  it('diffs tracked changes and untracked files against HEAD with counts', async () => {
    const dir = workspaceDir(STORAGE_KEY);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@x',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@x',
        },
        stdio: 'pipe',
      });
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'tracked.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(dir, 'gone.txt'), 'bye\n');
    git('add', 'tracked.txt', 'gone.txt');
    git('commit', '-q', '-m', 'base');
    await writeFile(join(dir, 'tracked.txt'), 'one\n2\nthree\nfour\n');
    await writeFile(join(dir, 'fresh.txt'), 'new\n');
    await rm(join(dir, 'gone.txt'));
    // Under root the worker drops git to the caller's uid, which must be
    // able to reach the checkout the way a real clone (owned by it) is.
    const identity = identityFor(TARGET);
    if (identity) {
      for (const parent of [root, join(root, 'tenant-1'), join(root, 'tenant-1', 'hash')]) {
        await chmod(parent, 0o755);
      }
      execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, dir], { stdio: 'pipe' });
    }
    const result = await post(enabledBase, 'workspaces/git-diff', {
      ...TARGET,
      id: 'ws-1',
      context: 1,
    });
    expect(result.status).toBe(200);
    expect(result.json.branch).toBe('main');
    expect(result.json.truncated).toBe(false);
    expect(result.json.files).toEqual(
      expect.arrayContaining([
        { path: 'tracked.txt', added: 2, deleted: 1, status: 'modified' },
        { path: 'fresh.txt', added: 1, deleted: 0, status: 'untracked' },
        { path: 'gone.txt', added: 0, deleted: 1, status: 'deleted' },
      ])
    );
    expect(result.json.diff).toContain('+++ b/tracked.txt');
    expect(result.json.diff).toContain('@@ -1,3 +1,4 @@');
    expect(result.json.diff).toContain('--- /dev/null');
    expect(result.json.diff).toContain('+new');
    const narrowed = await post(enabledBase, 'workspaces/git-diff', {
      ...TARGET,
      id: 'ws-1',
      paths: ['fresh.txt'],
    });
    expect(narrowed.json.files).toEqual([
      { path: 'fresh.txt', added: 1, deleted: 0, status: 'untracked' },
    ]);
    expect(narrowed.json.diff).not.toContain('tracked.txt');
  });
});

describe('git-show', () => {
  it('answers one commit by its hash: header, diff with counts, and whether it was pushed', async () => {
    // The repository git-diff set up above, with its tracked change now committed.
    const dir = workspaceDir(STORAGE_KEY);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ada',
          GIT_AUTHOR_EMAIL: 'ada@x',
          GIT_COMMITTER_NAME: 'Ada',
          GIT_COMMITTER_EMAIL: 'ada@x',
        },
        stdio: 'pipe',
      })
        .toString()
        .trim();
    // git-diff's test handed the checkout to the caller's uid where the
    // worker runs as root; git then refuses the test's own commands as
    // another user's repository unless told the directory is safe.
    git('-c', `safe.directory=${dir}`, 'add', 'tracked.txt');
    git(
      '-c',
      `safe.directory=${dir}`,
      'commit',
      '-q',
      '-m',
      'change two lines',
      '-m',
      'Because the old ones no longer matched the fixture.'
    );
    const sha = git('-c', `safe.directory=${dir}`, 'rev-parse', 'HEAD');
    const identity = identityFor(TARGET);
    if (identity) {
      execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, dir], { stdio: 'pipe' });
    }
    const result = await post(enabledBase, 'workspaces/git-show', {
      ...TARGET,
      id: 'ws-1',
      commit: sha.slice(0, 7),
      context: 1,
    });
    expect(result.status).toBe(200);
    expect(result.json.branch).toBe('main');
    expect(result.json.commit).toEqual(
      expect.objectContaining({
        sha,
        shortSha: sha.slice(0, 7),
        subject: 'change two lines',
        body: 'Because the old ones no longer matched the fixture.',
        author: 'Ada',
      })
    );
    expect(result.json.commit.parents).toHaveLength(1);
    expect(result.json.pushed).toBe(false);
    expect(result.json.inHead).toBe(true);
    expect(result.json.files).toEqual([
      { path: 'tracked.txt', added: 2, deleted: 1, status: 'modified' },
    ]);
    expect(result.json.diff).toContain('+++ b/tracked.txt');
    expect(result.json.diff).toContain('-two');
    const stat = await post(enabledBase, 'workspaces/git-show', {
      ...TARGET,
      id: 'ws-1',
      commit: sha,
      statOnly: true,
    });
    expect(stat.json.diff).toBe('');
    expect(stat.json.files).toHaveLength(1);
    expect(
      (await post(enabledBase, 'workspaces/git-show', { ...TARGET, id: 'ws-1', commit: 'HEAD' }))
        .status
    ).toBe(400);
    expect(
      (await post(enabledBase, 'workspaces/git-show', { ...TARGET, id: 'ws-1', commit: 'abcdef0' }))
        .status
    ).toBe(404);
  });
});

describe('git-discard', () => {
  it('resets tracked changes and removes untracked files', async () => {
    // Reuses the repository git-diff/git-show set up above: branch main,
    // HEAD at "change two lines", a clean working tree.
    const dir = workspaceDir(STORAGE_KEY);
    const identity = identityFor(TARGET);
    await writeFile(join(dir, 'tracked.txt'), 'one\n2\nthree\nfour\nFIVE\n');
    await writeFile(join(dir, 'scratch-untracked.txt'), 'oops\n');
    if (identity) {
      execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, dir], { stdio: 'pipe' });
    }
    const before = await post(enabledBase, 'workspaces/git-status', { ...TARGET, id: 'ws-1' });
    expect(before.json.status).toContain('tracked.txt');
    expect(before.json.status).toContain('scratch-untracked.txt');

    const discarded = await post(enabledBase, 'workspaces/git-discard', {
      ...TARGET,
      id: 'ws-1',
    });
    expect(discarded.status).toBe(200);
    expect(discarded.json.branch).toBe('main');

    const after = await post(enabledBase, 'workspaces/git-status', { ...TARGET, id: 'ws-1' });
    expect(after.json.status).not.toContain('tracked.txt');
    expect(after.json.status).not.toContain('scratch-untracked.txt');
    const read = await post(enabledBase, 'workspaces/read', {
      ...TARGET,
      id: 'ws-1',
      path: 'tracked.txt',
    });
    expect(read.json.text).toBe('one\n2\nthree\nfour\n');
    await expect(readFile(join(dir, 'scratch-untracked.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('ls', () => {
  it('marks entries the checkout ignores, without leaving them out', async () => {
    // Reuses the repository set up above: branch main, a clean working
    // tree at "change two lines".
    const dir = workspaceDir(STORAGE_KEY);
    const identity = identityFor(TARGET);
    await writeFile(join(dir, '.gitignore'), 'ignored-file.txt\nignored-dir/\n');
    await writeFile(join(dir, 'ignored-file.txt'), 'shh\n');
    await mkdir(join(dir, 'ignored-dir'), { recursive: true });
    await writeFile(join(dir, 'ignored-dir', 'inside.txt'), 'shh\n');
    if (identity) {
      execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, dir], { stdio: 'pipe' });
    }
    try {
      const result = await post(enabledBase, 'workspaces/ls', { ...TARGET, id: 'ws-1' });
      expect(result.status).toBe(200);
      const byPath = new Map<string, { ignored?: boolean }>(
        result.json.entries.map((entry: { path: string; ignored?: boolean }) => [
          entry.path,
          entry,
        ])
      );
      expect(byPath.get('ignored-file.txt')?.ignored).toBe(true);
      expect(byPath.get('ignored-dir')?.ignored).toBe(true);
      expect(byPath.get('tracked.txt')?.ignored).toBe(false);
      expect(byPath.get('.gitignore')?.ignored).toBe(false);
    } finally {
      await rm(join(dir, '.gitignore'), { force: true });
      await rm(join(dir, 'ignored-file.txt'), { force: true });
      await rm(join(dir, 'ignored-dir'), { recursive: true, force: true });
    }
  });
});

describe('uploading', () => {
  async function upload(query: Record<string, string>, body: Uint8Array<ArrayBuffer>) {
    const response = await fetch(
      `${enabledBase}/v1/workspaces/upload?${new URLSearchParams(query).toString()}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/octet-stream' },
        body,
      }
    );
    return { status: response.status, json: await response.json() };
  }

  it('writes the body as bytes at the path, under the checkout only', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xff]);
    const sent = await upload({ ...TARGET, id: 'ws-1', path: 'assets/logo.png' }, bytes);
    expect(sent.status).toBe(200);
    expect(sent.json).toEqual({ path: 'assets/logo.png', created: true, sizeBytes: 7 });
    expect(
      new Uint8Array(await readFile(join(workspaceDir(STORAGE_KEY), 'assets', 'logo.png')))
    ).toEqual(bytes);
    expect(
      (await upload({ ...TARGET, id: 'ws-1', path: '.git/hooks/pre-commit' }, bytes)).status
    ).toBe(400);
    expect((await upload({ ...TARGET, id: 'ws-1', path: '../escape.png' }, bytes)).status).toBe(
      400
    );
    expect(
      (await upload({ ...TARGET, id: 'ws-1', path: 'empty.bin' }, new Uint8Array())).status
    ).toBe(400);
    expect((await upload({ ...TARGET, id: 'ws-9', path: 'x.bin' }, bytes)).status).toBe(404);
  });
});

describe('env verbs', () => {
  it('sets a variable and lists names only', async () => {
    envStore.hasEnvSecret.mockResolvedValue(false);
    envStore.countEnvSecrets.mockResolvedValue(0);
    envStore.upsertEnvSecret.mockImplementation(
      async (_db: unknown, input: { name: string; sealed: string }) => {
        expect(input.sealed.startsWith('env1.')).toBe(true);
        expect(input.sealed).not.toContain('hunter2');
        return {
          id: 'e2',
          name: input.name,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastUsedAt: null,
        };
      }
    );
    const set = await post(enabledBase, 'env/set', {
      ...TARGET,
      name: 'API_KEY',
      value: 'hunter2',
    });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.json)).not.toContain('hunter2');
    expect(
      (await post(enabledBase, 'env/set', { ...TARGET, name: 'PATH', value: 'x' })).status
    ).toBe(400);
  });

  it('rejects the clone of anything but a Bitbucket https URL', async () => {
    workspaceStore.countWorkspaces.mockResolvedValue(0);
    const result = await post(enabledBase, 'workspaces/clone', {
      ...TARGET,
      provider: 'atlassian-bitbucket',
      repoFullName: 'acme/demo',
      cloneUrl: 'file:///etc',
      authHeader: 'Basic x',
    });
    expect(result.status).toBe(400);
    expect(workspaceStore.insertWorkspace).not.toHaveBeenCalled();
  });
});

describe('language servers over the wire', () => {
  // Its own server, with the sessions scripted: the fake speaks the
  // protocol over stdio exactly as a real one would.
  const { spawn: spawnChild } =
    jest.requireActual<typeof import('node:child_process')>('node:child_process');
  const { LspSessions } = jest.requireActual<typeof import('./lsp-sessions')>('./lsp-sessions');
  let lspServer: Server;
  let lspBase: string;
  let sessions: InstanceType<typeof LspSessions>;

  beforeAll(async () => {
    sessions = new LspSessions({
      spawnServer: () =>
        spawnChild(
          process.execPath,
          [join(__dirname, 'test-support', 'fake-language-server.mjs')],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          }
        ),
    });
    lspServer = createSandboxServer({
      db: {} as Kysely<DB>,
      apiKeys: [API_KEY],
      workspaces: true,
      lsp: sessions,
    });
    lspBase = await listen(lspServer);
  });

  afterAll(async () => {
    await sessions.closeAll();
    await new Promise((resolve) => lspServer.close(resolve));
  });

  it('says which servers this worker has (none on a bare test box, as a list)', async () => {
    const languages = await post(lspBase, 'workspaces/lsp/languages', TARGET);
    expect(languages.status).toBe(200);
    expect(Array.isArray(languages.json.languages)).toBe(true);
  });

  it('opens a server for a ready checkout, relays messages both ways, scrubs, and closes', async () => {
    // The fake's hover says "token=hunter2"; make that a value of the caller's environment.
    envStore.listSealedEnv.mockResolvedValue([
      { id: 'e2', name: 'API_TOKEN', sealed: sealEnvValue('hunter2', envSecretsKey()!) },
    ]);
    const bad = await post(lspBase, 'workspaces/lsp/open', {
      ...TARGET,
      id: 'ws-1',
      server: 'cobol',
      clientId: 'ed',
    });
    expect(bad.status).toBe(400);
    const noClient = await post(lspBase, 'workspaces/lsp/open', {
      ...TARGET,
      id: 'ws-1',
      server: 'typescript',
    });
    expect(noClient.status).toBe(400);
    const notMine = await post(lspBase, 'workspaces/lsp/open', {
      tenantId: 'tenant-1',
      subject: 'bob',
      id: 'ws-1',
      server: 'typescript',
      clientId: 'ed',
    });
    expect(notMine.status).toBe(404);

    const opened = await post(lspBase, 'workspaces/lsp/open', {
      ...TARGET,
      id: 'ws-1',
      server: 'typescript',
      clientId: 'ed',
    });
    expect(opened.status).toBe(200);
    expect(opened.json.rootUri).toBe(`file://${workspaceDir(STORAGE_KEY)}`);
    expect(opened.json.capabilities.hoverProvider).toBe(true);
    const session: string = opened.json.id;

    // A message naming a file outside the checkout never reaches the server.
    const outside = await post(lspBase, 'workspaces/lsp/send', {
      ...TARGET,
      session,
      message: {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri: 'file:///etc/passwd' } },
      },
    });
    expect(outside.status).toBe(400);
    expect(outside.json.error.type).toBe('bad_message');
    const lifecycle = await post(lspBase, 'workspaces/lsp/send', {
      ...TARGET,
      session,
      message: { jsonrpc: '2.0', id: 1, method: 'shutdown' },
    });
    expect(lifecycle.status).toBe(400);
    const someoneElse = await post(lspBase, 'workspaces/lsp/send', {
      tenantId: 'tenant-1',
      subject: 'bob',
      session,
      message: { jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: {} },
    });
    expect(someoneElse.status).toBe(404);

    const uri = `${opened.json.rootUri}/src/config.ts`;
    const sent = await post(lspBase, 'workspaces/lsp/send', {
      ...TARGET,
      session,
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'textDocument/hover',
        params: { textDocument: { uri }, position: { line: 0, character: 0 } },
      },
    });
    expect(sent.status).toBe(202);

    // The events stream: what the server said, one message per event, scrubbed.
    const controller = new AbortController();
    const events = await fetch(`${lspBase}/v1/workspaces/lsp/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...TARGET, session }),
      signal: controller.signal,
    });
    expect(events.status).toBe(200);
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('window/showDocument')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    controller.abort();
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(data[0]).toMatchObject({ id: 1 });
    expect(data[0].result.contents.value).toContain('token=••••••');
    expect(text).not.toContain('hunter2');
    expect(data[1]).toMatchObject({ method: 'window/showDocument' });

    const closed = await post(lspBase, 'workspaces/lsp/close', { ...TARGET, session });
    expect(closed.json).toEqual({ closed: true });
    const gone = await post(lspBase, 'workspaces/lsp/send', {
      ...TARGET,
      session,
      message: {
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      },
    });
    expect(gone.status).toBe(404);
  });
});
