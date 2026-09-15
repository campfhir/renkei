/**
 * The workspace runtime against a real temporary directory and a real
 * git: containment of caller paths, a command's clean environment and
 * timeout, and a clone → read → grep → edit round trip from a local
 * repository. Identity is null throughout (no uid drop), which is the
 * non-root arrangement the module documents; the setpriv wrapping is
 * pinned separately as pure argument construction.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  childEnvironment,
  cloneRepository,
  containedPath,
  ensureCallerDirs,
  ensureWorkspacesRoot,
  findFiles,
  getWorkspacesRoot,
  grepFiles,
  homeDir,
  listDirectory,
  newWorkspaceStorageKey,
  readWorkspaceFile,
  runShell,
  setWorkspacesRootForTests,
  shellPrelude,
  workspaceDir,
  wrapCommand,
  writeWorkspaceFile,
  WorkspacePathError,
} from './workspaces';

let root: string;
let origin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'renkei-ws-'));
  setWorkspacesRootForTests(join(root, 'workspaces'));
  origin = join(root, 'origin');
  await mkdir(join(origin, 'src'), { recursive: true });
  await writeFile(join(origin, 'README.md'), '# Demo\n\nhello world\n');
  await writeFile(
    join(origin, 'src', 'index.ts'),
    'export const answer = 42;\nconsole.log(answer);\n'
  );
  await writeFile(join(origin, '.gitignore'), 'node_modules/\n');
  await mkdir(join(origin, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(origin, 'node_modules', 'x', 'index.js'), 'answer');
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'first');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('wrapCommand', () => {
  it('drops to the caller uid with no groups, caps or new privileges', () => {
    expect(wrapCommand({ uid: 100_007, gid: 100_007 }, 'bash', ['-c', 'id'])).toEqual({
      file: 'setpriv',
      args: [
        '--reuid=100007',
        '--regid=100007',
        '--clear-groups',
        '--no-new-privs',
        '--bounding-set=-all',
        '--inh-caps=-all',
        '--',
        'bash',
        '-c',
        'id',
      ],
    });
    expect(wrapCommand(null, 'bash', ['-c', 'id'])).toEqual({ file: 'bash', args: ['-c', 'id'] });
  });

  it('builds the environment from nothing and carries a git header as config, not argv', () => {
    const env = childEnvironment({
      cwd: '/w',
      home: '/h',
      identity: null,
      env: { NPM_TOKEN: 'abc' },
      timeoutMs: 1,
      gitAuthHeader: 'Basic xyz',
    });
    expect(env.NPM_TOKEN).toBe('abc');
    expect(env.HOME).toBe('/h');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SANDBOX_WORKER_API_KEY).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://bitbucket.org/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Authorization: Basic xyz');
    expect(shellPrelude()).toMatch(/^ulimit -u \d+ -f \d+ -c 0/);
  });
});

describe('directory permissions under a restrictive umask', () => {
  // The real worker raises its umask to 0077 before it ever touches the
  // workspaces volume, so a caller's uid reads nothing else it creates.
  // mkdir's `mode` option goes through that umask like any other
  // creation call — only chmod, applied after, is immune to it. Without
  // that chmod, /workspaces and each tenant's directory would end up
  // 0700 (umask 0077 clears every group/other bit from a requested
  // 0711), sealing every caller's uid out of a root it only needs to
  // walk through — exactly the "could not create leading directories:
  // Permission denied" a real clone would then hit.
  const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

  it('leaves the workspaces root traversable by everyone', async () => {
    const previous = process.umask(0o077);
    try {
      await ensureWorkspacesRoot();
    } finally {
      process.umask(previous);
    }
    expect(await modeOf(getWorkspacesRoot())).toBe(0o711);
  });

  it("leaves a tenant's directory traversable by everyone", async () => {
    const storageKey = newWorkspaceStorageKey('umask-tenant', 'someone');
    const previous = process.umask(0o077);
    try {
      await ensureCallerDirs(storageKey, null);
    } finally {
      process.umask(previous);
    }
    const tenantDir = join(getWorkspacesRoot(), 'umask-tenant');
    expect(await modeOf(tenantDir)).toBe(0o711);
  });
});

describe('a cloned workspace', () => {
  const storageKey = 'tenant-1/subjecthash/ws-1';

  it('clones a repository and reports its branch', async () => {
    const outcome = await cloneRepository({
      storageKey,
      identity: null,
      cloneUrl: origin,
      authHeader: 'Basic unused-for-a-local-clone',
      branch: '',
      depth: 0,
    });
    expect(outcome).toEqual({ ok: true, branch: 'main' });
    expect(
      (await readFile(join(workspaceDir(storageKey), 'README.md'), 'utf8')).startsWith('# Demo')
    ).toBe(true);
  });

  it('reports a clone that fails without leaving a directory', async () => {
    const outcome = await cloneRepository({
      storageKey: 'tenant-1/subjecthash/ws-bad',
      identity: null,
      cloneUrl: origin,
      authHeader: 'Basic x',
      branch: 'no-such-branch',
      depth: 0,
    });
    expect(outcome.ok).toBe(false);
    await expect(
      readFile(join(workspaceDir('tenant-1/subjecthash/ws-bad'), 'README.md'))
    ).rejects.toThrow();
  });

  it('reads, lists, finds and greps inside the checkout, honouring .gitignore', async () => {
    const dir = workspaceDir(storageKey);
    const read = await readWorkspaceFile(dir, 'src/index.ts', 1_000_000);
    expect('bytes' in read && read.bytes.toString('utf8')).toContain('answer = 42');
    const listed = await listDirectory(dir, '');
    expect(Array.isArray(listed) && listed.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['README.md', 'src', '.gitignore'])
    );
    const found = await findFiles({
      dir,
      home: homeDir(storageKey),
      identity: null,
      glob: '**/*.ts',
    });
    expect(found).toEqual({ paths: ['src/index.ts'], truncated: false });
    const matches = await grepFiles({
      dir,
      home: homeDir(storageKey),
      identity: null,
      pattern: 'answer',
      path: '',
      glob: '**/*',
      caseInsensitive: false,
      fixedStrings: true,
    });
    expect('matches' in matches && matches.matches.map((match) => match.path)).toEqual([
      'src/index.ts',
      'src/index.ts',
    ]);
    expect('matches' in matches && matches.matches[0]).toEqual({
      path: 'src/index.ts',
      line: 1,
      text: 'export const answer = 42;',
    });
  });

  it('writes a new file with its parent directories', async () => {
    const dir = workspaceDir(storageKey);
    const written = await writeWorkspaceFile(dir, 'docs/notes/todo.md', '- one\n', null);
    expect(written).toEqual({ created: true, sizeBytes: 6 });
    expect(await readFile(join(dir, 'docs', 'notes', 'todo.md'), 'utf8')).toBe('- one\n');
    const again = await writeWorkspaceFile(dir, 'docs/notes/todo.md', '- two\n', null);
    expect(again.created).toBe(false);
  });

  it('refuses a path that a symlink would carry outside', async () => {
    const dir = workspaceDir(storageKey);
    await symlink('/etc', join(dir, 'escape'));
    await expect(containedPath(dir, 'escape/hostname')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(readWorkspaceFile(dir, 'escape/hostname', 1_000)).rejects.toBeInstanceOf(
      WorkspacePathError
    );
    await expect(writeWorkspaceFile(dir, 'escape/x', 'no', null)).rejects.toBeInstanceOf(
      WorkspacePathError
    );
    await expect(containedPath(dir, 'new-dir/new-file')).resolves.toBe(
      join(dir, 'new-dir', 'new-file')
    );
  });

  it('runs a command in the checkout with a clean environment', async () => {
    const dir = workspaceDir(storageKey);
    const result = await runShell(
      {
        cwd: dir,
        home: homeDir(storageKey),
        identity: null,
        env: { NPM_TOKEN: 'sekret' },
        timeoutMs: 10_000,
      },
      'echo "$NPM_TOKEN|$HOME|${DATABASE_URL:-unset}"; cat README.md | head -1; exit 3'
    );
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe(`sekret|${homeDir(storageKey)}|unset\n# Demo\n`);
  });

  it('kills a command tree that outlives its timeout', async () => {
    const dir = workspaceDir(storageKey);
    const started = Date.now();
    const result = await runShell(
      { cwd: dir, home: homeDir(storageKey), identity: null, env: {}, timeoutMs: 500 },
      'sleep 30 & sleep 30; echo never'
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain('never');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
