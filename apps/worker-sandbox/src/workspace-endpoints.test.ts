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
import { identityFor, setWorkspacesRootForTests, workspaceDir } from './workspaces';
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
      expect(result.json.error.message).toMatch(
        /checkout is gone .*next chat message.*clones the repository again/
      );
    }
    expect(workspaceStore.setWorkspaceStatus).toHaveBeenCalledWith(
      expect.anything(),
      'ws-gone',
      'failed',
      { error: expect.stringContaining('no longer on the worker') }
    );
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
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'base');
    await writeFile(join(dir, 'tracked.txt'), 'one\n2\nthree\nfour\n');
    await writeFile(join(dir, 'fresh.txt'), 'new\n');
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
