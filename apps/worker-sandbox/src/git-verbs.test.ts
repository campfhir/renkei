/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any */
/**
 * The rest of git over the wire, against a real repository with a real
 * (local, bare) remote: the history read back as records, branches made,
 * switched and deleted, a stash pushed and popped, a reset that keeps the
 * work, a clean that is dry unless told otherwise, a rebase that stops on
 * a conflict and says so in the status until it is aborted, a merge that
 * fast-forwards, a sparse checkout narrowed and widened again, a fetch
 * that brings the remote's new commit, and a push that replaces the
 * remote branch only with the lease.
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
  getWorkspaceById: jest.fn(),
  listWorktrees: jest.fn(),
  listWorktreesOf: jest.fn(),
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
import { createSandboxServer } from './server';
import { ALL_ORG_FEATURES } from './features';
import { identityFor, setWorkspacesRootForTests, workspaceDir } from './workspaces';
import { parseLog } from './git-verbs';
import { resetEnvSecretsKeyForTests } from './env-secrets';

const workspaceStore = jest.requireMock<Record<string, jest.Mock>>('./workspace-store');
const envStore = jest.requireMock<Record<string, jest.Mock>>('./env-secrets-store');

const API_KEY = 'test-worker-key';
const TARGET = { subject: 'code-project:git' };
const STORAGE_KEY = 'tenant-1/hash/ws-git';
const PROXY = { base: 'http://delegate/git/ticket/', insteadOf: 'https://github.com/' };

let root: string;
let server: Server;
let base: string;
let dir: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  // The test's own git runs as whoever runs the tests; the checkout and the
  // remote are handed to the project's uid, so a global config (the only
  // place git honours safe.directory for a spawned upload-pack) names
  // every directory safe.
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(root, 'test-gitconfig'),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@x',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@x',
    },
    stdio: 'pipe',
  })
    .toString()
    .trim();
}

/** Under root the worker drops git to the caller's uid, which must own the checkout (and, here, the local remote). */
function handOver(): void {
  const identity = identityFor(TARGET);
  if (identity) {
    execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, dir, remote], {
      stdio: 'pipe',
    });
  }
}

async function post(op: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...TARGET, id: 'ws-git', ...(body as object) }),
  });
  return { status: response.status, json: await response.json() };
}

beforeAll(async () => {
  process.env.SANDBOX_ENV_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');
  resetEnvSecretsKeyForTests();
  root = await mkdtemp(join(tmpdir(), 'renkei-gitverbs-'));
  setWorkspacesRootForTests(root);
  await writeFile(join(root, 'test-gitconfig'), '[safe]\n\tdirectory = *\n');
  dir = workspaceDir(STORAGE_KEY);
  await mkdir(join(root, 'tenant-1', 'hash', 'home'), { recursive: true });
  for (const parent of [root, join(root, 'tenant-1'), join(root, 'tenant-1', 'hash')]) {
    await chmod(parent, 0o755);
  }
  // A remote with a history, and the checkout as a clone of it.
  remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await mkdir(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await mkdir(join(seed, 'apps', 'web'), { recursive: true });
  await mkdir(join(seed, 'docs'), { recursive: true });
  await writeFile(join(seed, 'apps', 'web', 'index.ts'), 'export const a = 1;\n');
  await writeFile(join(seed, 'docs', 'readme.md'), '# docs\n');
  await writeFile(join(seed, 'shared.txt'), 'one\ntwo\nthree\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'first: the layout');
  await writeFile(join(seed, 'shared.txt'), 'one\ntwo\nthree\nfour\n');
  git(seed, 'commit', '-q', '-am', 'second: four');
  git(root, 'init', '-q', '-b', 'main', '--bare', remote);
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', remote, dir);
  git(dir, 'config', 'user.email', 't@x');
  git(dir, 'config', 'user.name', 't');
  handOver();

  server = createSandboxServer({
    apiKeys: [API_KEY],
    workspaces: true,
    orgFeatures: async () => ALL_ORG_FEATURES,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  delete process.env.SANDBOX_ENV_SECRETS_KEY;
  resetEnvSecretsKeyForTests();
});

beforeEach(() => {
  jest.clearAllMocks();
  workspaceStore.getWorkspace.mockImplementation(async (target: { subject: string }, id: string) =>
    target.subject === TARGET.subject && id === 'ws-git'
      ? {
          id: 'ws-git',
          subject: TARGET.subject,
          provider: 'github',
          repoFullName: 'acme/demo',
          branch: 'main',
          storageKey: STORAGE_KEY,
          parentId: null,
          status: 'ready',
          error: null,
          sizeBytes: 10,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }
      : undefined
  );
  workspaceStore.touchWorkspace.mockResolvedValue(undefined);
  envStore.touchEnvSecretsUsed.mockResolvedValue(undefined);
  envStore.listSealedEnv.mockResolvedValue([]);
});

describe('git-log', () => {
  it('answers commits as records, newest first, narrowed by range, path and text', async () => {
    const all = await post('workspaces/git-log', {});
    expect(all.status).toBe(200);
    expect(all.json.branch).toBe('main');
    expect(all.json.commits.map((c: any) => c.subject)).toEqual([
      'second: four',
      'first: the layout',
    ]);
    expect(all.json.commits[0]).toEqual(
      expect.objectContaining({
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        author: 't',
        email: 't@x',
        parents: [all.json.commits[1].sha],
      })
    );
    expect(all.json.commits[0].refs).toEqual(expect.arrayContaining(['main', 'origin/main']));
    expect(all.json.truncated).toBe(false);

    const byPath = await post('workspaces/git-log', { paths: ['docs'] });
    expect(byPath.json.commits.map((c: any) => c.subject)).toEqual(['first: the layout']);
    const byText = await post('workspaces/git-log', { grep: 'FOUR' });
    expect(byText.json.commits.map((c: any) => c.subject)).toEqual(['second: four']);
    const range = await post('workspaces/git-log', { ref: 'HEAD~1..HEAD' });
    expect(range.json.commits).toHaveLength(1);
    const paged = await post('workspaces/git-log', { max: 1 });
    expect(paged.json.commits).toHaveLength(1);
    expect(paged.json.truncated).toBe(true);
  });

  it('refuses an option where a revision goes', async () => {
    expect((await post('workspaces/git-log', { ref: '--output=/tmp/x' })).status).toBe(400);
    expect((await post('workspaces/git-log', { ref: 'nope' })).status).toBe(409);
  });

  it('parses the record format', () => {
    const [entry] = parseLog(
      [
        'abc',
        'abc1',
        'subject',
        'Ada',
        'ada@x',
        '2024-01-01T00:00:00+00:00',
        'HEAD -> main, origin/main',
        'p1 p2',
      ].join('\0') + '\x1e\n'
    );
    expect(entry).toEqual({
      sha: 'abc',
      shortSha: 'abc1',
      subject: 'subject',
      author: 'Ada',
      email: 'ada@x',
      date: '2024-01-01T00:00:00+00:00',
      refs: ['main', 'origin/main'],
      parents: ['p1', 'p2'],
    });
  });
});

describe('git-branch', () => {
  it('lists, creates, switches to and deletes branches', async () => {
    const listed = await post('workspaces/git-branch', { action: 'list' });
    expect(listed.status).toBe(200);
    expect(listed.json.local).toEqual([
      expect.objectContaining({ name: 'main', current: true, upstream: 'origin/main' }),
    ]);
    expect(listed.json.remote.map((b: any) => b.name)).toEqual(['origin/main']);

    const created = await post('workspaces/git-branch', {
      action: 'create',
      name: 'feature/x',
      start: 'HEAD~1',
    });
    expect(created.status).toBe(200);
    expect(created.json.branch).toBe('main');

    const switched = await post('workspaces/git-branch', { action: 'switch', name: 'feature/x' });
    expect(switched.json.branch).toBe('feature/x');
    expect(await readFile(join(dir, 'shared.txt'), 'utf8')).toBe('one\ntwo\nthree\n');

    const made = await post('workspaces/git-branch', {
      action: 'switch',
      name: 'feature/y',
      create: true,
      start: 'main',
    });
    expect(made.json.branch).toBe('feature/y');

    expect((await post('workspaces/git-branch', { action: 'switch', name: 'main' })).status).toBe(
      200
    );
    const deleted = await post('workspaces/git-branch', { action: 'delete', name: 'feature/y' });
    expect(deleted.status).toBe(200);
    // Not merged into main: refused without force, taken with it.
    expect(
      (await post('workspaces/git-branch', { action: 'delete', name: 'feature/x' })).status
    ).toBe(200);
    const names = (await post('workspaces/git-branch', {})).json.local.map((b: any) => b.name);
    expect(names).toEqual(['main']);
    expect((await post('workspaces/git-branch', { action: 'delete', name: '-D' })).status).toBe(
      400
    );
  });
});

describe('git-stash, git-reset and git-clean', () => {
  it('stashes work away and brings it back', async () => {
    await writeFile(join(dir, 'shared.txt'), 'changed\n');
    await writeFile(join(dir, 'new.txt'), 'new\n');
    handOver();
    const pushed = await post('workspaces/git-stash', {
      action: 'push',
      message: 'wip',
      includeUntracked: true,
    });
    expect(pushed.status).toBe(200);
    expect(pushed.json.stashes).toEqual([
      expect.objectContaining({ index: 0, ref: 'stash@{0}', message: 'On main: wip' }),
    ]);
    expect(await readFile(join(dir, 'shared.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\n');
    await expect(readFile(join(dir, 'new.txt'))).rejects.toThrow();

    const shown = await post('workspaces/git-stash', { action: 'show', index: 0 });
    expect(shown.json.output).toContain('shared.txt');

    const popped = await post('workspaces/git-stash', { action: 'pop' });
    expect(popped.status).toBe(200);
    expect(popped.json.stashes).toEqual([]);
    expect(await readFile(join(dir, 'shared.txt'), 'utf8')).toBe('changed\n');
    expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('new\n');
    expect((await post('workspaces/git-stash', { action: 'drop', index: 5 })).status).toBe(409);
  });

  it('resets softly, keeping the work, and names the new head', async () => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'to be undone');
    handOver();
    const reset = await post('workspaces/git-reset', { mode: 'soft', target: 'HEAD~1' });
    expect(reset.status).toBe(200);
    expect(reset.json.head).toMatch(/second: four$/);
    const status = await post('workspaces/git-status', {});
    expect(status.json.status).toContain('M  shared.txt');
    expect(status.json.inProgress).toBeNull();
    expect(status.json.conflicts).toEqual([]);
    // Paths: unstaged, not moved.
    const unstaged = await post('workspaces/git-reset', { paths: ['shared.txt'] });
    expect(unstaged.status).toBe(200);
    expect((await post('workspaces/git-status', {})).json.status).toContain(' M shared.txt');
    expect((await post('workspaces/git-reset', { mode: 'sideways' })).status).toBe(400);
    expect((await post('workspaces/git-reset', { mode: 'hard', target: '--mixed' })).status).toBe(
      400
    );
    const hard = await post('workspaces/git-reset', { mode: 'hard' });
    expect(hard.status).toBe(200);
    expect(await readFile(join(dir, 'shared.txt'), 'utf8')).toBe('one\ntwo\nthree\nfour\n');
  });

  it('cleans dry by default and for real when told', async () => {
    await mkdir(join(dir, 'build'), { recursive: true });
    await writeFile(join(dir, 'build', 'out.js'), '');
    handOver();
    const dry = await post('workspaces/git-clean', {});
    expect(dry.status).toBe(200);
    expect(dry.json.dryRun).toBe(true);
    // new.txt was committed by the reset test above; only build/ is untracked now.
    expect(dry.json.paths).toEqual(['build']);
    const real = await post('workspaces/git-clean', { dryRun: false, paths: ['build'] });
    expect(real.json.dryRun).toBe(false);
    expect(real.json.paths).toEqual(['build']);
    await expect(readFile(join(dir, 'build', 'out.js'))).rejects.toThrow();
    await post('workspaces/git-clean', { dryRun: false });
  });
});

describe('git-rebase and git-merge', () => {
  it('stops on a conflict, shows it in the status, and aborts cleanly', async () => {
    // A branch that changes the same line main then changes differently.
    git(dir, 'switch', '-q', '-c', 'topic', 'HEAD~1');
    await writeFile(join(dir, 'shared.txt'), 'one\ntwo\nthree\nTOPIC\n');
    git(dir, 'commit', '-q', '-am', 'topic change');
    handOver();
    const rebased = await post('workspaces/git-rebase', {
      action: 'start',
      onto: 'main',
      author: { name: 'Ada', email: 'ada@x' },
    });
    expect(rebased.status).toBe(200);
    expect(rebased.json.completed).toBe(false);
    expect(rebased.json.inProgress).toBe('rebase');
    expect(rebased.json.conflicts).toEqual(['shared.txt']);
    expect(rebased.json.output).toContain('CONFLICT');

    const status = await post('workspaces/git-status', {});
    expect(status.json.inProgress).toBe('rebase');
    expect(status.json.conflicts).toEqual(['shared.txt']);

    const again = await post('workspaces/git-rebase', { action: 'start', onto: 'main' });
    expect(again.status).toBe(409);
    expect(again.json.error.type).toBe('git_in_progress');

    // Resolved (the file edited, nothing staged — continue stages it) and
    // continued: the rebase finishes on top of main.
    await writeFile(join(dir, 'shared.txt'), 'one\ntwo\nthree\nfour\nTOPIC\n');
    handOver();
    const continued = await post('workspaces/git-rebase', {
      action: 'continue',
      author: { name: 'Ada', email: 'ada@x' },
    });
    expect(continued.status).toBe(200);
    expect(continued.json.completed).toBe(true);
    expect(continued.json.inProgress).toBeNull();
    expect(continued.json.branch).toBe('topic');
    const log = await post('workspaces/git-log', { max: 3 });
    expect(log.json.commits.map((c: any) => c.subject)).toEqual([
      'topic change',
      'second: four',
      'first: the layout',
    ]);
    expect((await post('workspaces/git-status', {})).json.inProgress).toBeNull();

    const bad = await post('workspaces/git-rebase', { action: 'start', onto: '--root' });
    expect(bad.status).toBe(400);
  });

  it('merges a branch into the current one and reports a completed merge', async () => {
    await post('workspaces/git-branch', { action: 'switch', name: 'main' });
    const merged = await post('workspaces/git-merge', {
      action: 'start',
      ref: 'topic',
      noFastForward: true,
      message: 'Merge topic',
      author: { name: 'Ada', email: 'ada@x' },
    });
    expect(merged.status).toBe(200);
    expect(merged.json.completed).toBe(true);
    expect(merged.json.branch).toBe('main');
    const log = await post('workspaces/git-log', { max: 1 });
    expect(log.json.commits[0].subject).toBe('Merge topic');
    expect(log.json.commits[0].parents).toHaveLength(2);
    expect((await post('workspaces/git-merge', { action: 'abort' })).status).toBe(409);
  });
});

describe('git-fetch and git-push', () => {
  it('fetches what the remote has and pushes with the lease only when asked', async () => {
    // Someone else moved the remote on.
    const other = join(root, 'other');
    git(root, 'clone', '-q', remote, other);
    await writeFile(join(other, 'docs', 'readme.md'), '# docs\nmore\n');
    git(other, 'commit', '-q', '-am', 'remote: more docs');
    git(other, 'push', '-q', 'origin', 'main');
    handOver();

    const fetched = await post('workspaces/git-fetch', { gitProxy: PROXY });
    expect(fetched.status).toBe(200);
    expect(fetched.json.output).toContain('main');
    const remoteLog = await post('workspaces/git-log', { ref: 'origin/main', max: 1 });
    expect(remoteLog.json.commits[0].subject).toBe('remote: more docs');

    // Local main has the merge, the remote the other commit: a plain push is
    // refused, and so is --force-with-lease (the lease is stale after the
    // fetch moved origin/main)... until rebased onto it.
    const plain = await post('workspaces/git-push', { gitProxy: PROXY });
    expect(plain.status).toBe(409);
    const rebased = await post('workspaces/git-rebase', { action: 'start', onto: 'origin/main' });
    expect(rebased.json.completed).toBe(true);
    const pushed = await post('workspaces/git-push', { gitProxy: PROXY });
    expect(pushed.status).toBe(200);
    expect(pushed.json.forced).toBe(false);

    // Rewrite the last commit; the remote branch has to be replaced.
    git(dir, 'commit', '-q', '--amend', '-m', 'Merge topic (amended)');
    handOver();
    const refused = await post('workspaces/git-push', { gitProxy: PROXY });
    expect(refused.status).toBe(409);
    const forced = await post('workspaces/git-push', { gitProxy: PROXY, forceWithLease: true });
    expect(forced.status).toBe(200);
    expect(forced.json.forced).toBe(true);
    expect(git(other, 'fetch', '-q', 'origin')).toBe('');
    expect(git(other, 'log', '-1', '--format=%s', 'origin/main')).toBe('Merge topic (amended)');
  });
});

describe('git-sparse-checkout', () => {
  it('narrows the working tree to the named directories and widens it again', async () => {
    const before = await post('workspaces/git-sparse-checkout', {});
    expect(before.json).toEqual(expect.objectContaining({ enabled: false, patterns: [] }));
    const set = await post('workspaces/git-sparse-checkout', {
      action: 'set',
      paths: ['apps/web'],
    });
    expect(set.status).toBe(200);
    expect(set.json.enabled).toBe(true);
    expect(set.json.patterns).toEqual(['apps/web']);
    await expect(readFile(join(dir, 'docs', 'readme.md'))).rejects.toThrow();
    expect(await readFile(join(dir, 'apps', 'web', 'index.ts'), 'utf8')).toContain('a = 1');
    const added = await post('workspaces/git-sparse-checkout', { action: 'add', paths: ['docs'] });
    expect(added.json.patterns).toEqual(['apps/web', 'docs']);
    expect(await readFile(join(dir, 'docs', 'readme.md'), 'utf8')).toContain('docs');
    const disabled = await post('workspaces/git-sparse-checkout', { action: 'disable' });
    expect(disabled.json.enabled).toBe(false);
    expect(
      (await post('workspaces/git-sparse-checkout', { action: 'set', paths: [] })).status
    ).toBe(400);
    expect(
      (await post('workspaces/git-sparse-checkout', { action: 'set', paths: ['../x'] })).status
    ).toBe(400);
  });
});
