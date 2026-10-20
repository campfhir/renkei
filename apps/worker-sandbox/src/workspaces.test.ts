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
  addWorktree,
  checkoutExists,
  childEnvironment,
  cloneRepository,
  containedPath,
  ensureWorkspacesRoot,
  findFiles,
  getWorkspacesRoot,
  grepFiles,
  homeDir,
  interruptRunningProcesses,
  isCheckoutStorageKey,
  listDirectory,
  mkdirWorkspaceFile,
  newWorkspaceStorageKey,
  readWorkspaceFile,
  removeWorkspace,
  removeWorkspaceFile,
  removeWorktree,
  renameWorkspaceFile,
  runProcess,
  runShell,
  setWorkspacesRootForTests,
  shellPrelude,
  verifyNetworkIsolation,
  verifyUidIsolation,
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

  it('enters an empty network namespace before the drop for netns, and never without an identity', () => {
    const wrapped = wrapCommand({ uid: 100_007, gid: 100_007 }, 'python3', ['main.py'], 'netns');
    expect(wrapped.file).toBe('unshare');
    expect(wrapped.args.slice(0, 3)).toEqual(['--net', '--', 'setpriv']);
    expect(wrapped.args.slice(-2)).toEqual(['python3', 'main.py']);
    expect(wrapCommand(null, 'python3', ['main.py'], 'netns')).toEqual({
      file: 'python3',
      args: ['main.py'],
    });
  });

  it('enters a user namespace of the caller’s own AFTER the drop for userns, mapping the uid to itself', () => {
    const wrapped = wrapCommand({ uid: 100_007, gid: 100_007 }, 'python3', ['main.py'], 'userns');
    expect(wrapped.file).toBe('setpriv');
    expect(wrapped.args.slice(0, 2)).toEqual(['--reuid=100007', '--regid=100007']);
    expect(wrapped.args.slice(-7)).toEqual([
      'unshare',
      '-Un',
      '--map-user=100007',
      '--map-group=100007',
      '--',
      'python3',
      'main.py',
    ]);
    // Without an identity (an unprivileged worker) the namespace is still made, as this process.
    const own = wrapCommand(null, 'python3', ['main.py'], 'userns');
    expect(own.file).toBe('unshare');
    expect(own.args[0]).toBe('-Un');
    expect(own.args[1]).toBe(`--map-user=${process.getuid?.() ?? 65534}`);
    expect(own.args.slice(-2)).toEqual(['python3', 'main.py']);
  });

  it('builds the environment from nothing and points git at the proxy as config, not argv', () => {
    const env = childEnvironment({
      cwd: '/w',
      home: '/h',
      identity: null,
      env: { NPM_TOKEN: 'abc' },
      timeoutMs: 1,
      gitProxy: {
        base: 'http://delegate:8096/git/ticket/bitbucket.org/',
        insteadOf: 'https://bitbucket.org/',
      },
    });
    expect(env.NPM_TOKEN).toBe('abc');
    expect(env.HOME).toBe('/h');
    // The image's toolchains are on the PATH; their caches live under HOME.
    expect(env.PATH).toContain('/usr/local/go/bin');
    expect(env.PATH).toContain('/usr/local/cargo/bin');
    expect(env.GOPATH).toBe('/h/go');
    expect(env.CARGO_HOME).toBe('/h/.cargo');
    expect(env.XDG_CACHE_HOME).toBe('/h/.cache');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.SANDBOX_WORKER_API_KEY).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe(
      'url.http://delegate:8096/git/ticket/bitbucket.org/.insteadOf'
    );
    expect(env.GIT_CONFIG_VALUE_0).toBe('https://bitbucket.org/');
    expect(shellPrelude()).toMatch(/^ulimit -u \d+ -f \d+ -c 0/);
  });
});

describe('removing a checkout', () => {
  it('accepts the key newWorkspaceStorageKey produces: caller hash, checkout id', () => {
    const key = newWorkspaceStorageKey('user:alice');
    expect(key).toMatch(/^[0-9a-f]{64}\/[0-9a-f-]{36}$/);
    expect(isCheckoutStorageKey(key)).toBe(true);
    expect(isCheckoutStorageKey('abc123/uuid')).toBe(true);
  });

  it('refuses a key that names anything but exactly one checkout', () => {
    for (const bad of [
      '',
      'abc123',
      'abc123/',
      '/uuid',
      'abc123//uuid',
      '../uuid',
      'abc123/..',
      'a/../b',
      './uuid',
      'abc123/.',
      // The pre-single-organization shape, `<tenant>/<caller>/<checkout>`.
      'tenant/abc123/uuid',
      'a/b/c/d',
      '/a/b',
    ]) {
      expect(isCheckoutStorageKey(bad)).toBe(false);
    }
  });

  it('refuses a malformed key rather than reaching for more than one checkout', async () => {
    await expect(removeWorkspace('')).rejects.toThrow(/malformed storage key/);
    await expect(removeWorkspace('abc123')).rejects.toThrow(/malformed storage key/);
    await expect(removeWorkspace('abc123/../uuid')).rejects.toThrow(/malformed storage key/);
    await expect(removeWorkspace('abc123/uuid')).resolves.toBeUndefined();
  });

  it('removes an expired checkout by its stored key and leaves the caller directory', async () => {
    const key = newWorkspaceStorageKey('user:sweep');
    const dir = workspaceDir(key);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export {};\n');
    const sibling = join(workspaceDir(newWorkspaceStorageKey('user:sweep')), 'keep.txt');
    await mkdir(join(sibling, '..'), { recursive: true });
    await writeFile(sibling, 'still here');
    expect(await checkoutExists(key)).toBe(true);

    await removeWorkspace(key);

    expect(await checkoutExists(key)).toBe(false);
    await expect(stat(dir)).rejects.toThrow();
    await expect(readFile(sibling, 'utf8')).resolves.toBe('still here');
    await expect(stat(join(dir, '..'))).resolves.toBeDefined();
  });
});

describe('a command that never starts', () => {
  // Node reports a vanished working directory and a missing executable
  // with the same `spawn <file> ENOENT`; the result must say which.
  const input = (cwd: string) => ({ cwd, home: root, identity: null, env: {}, timeoutMs: 5_000 });

  it('blames the working directory when it is gone, not the command', async () => {
    const result = await runProcess(input(join(root, 'vanished')), 'bash', ['-c', 'true']);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('spawn bash ENOENT');
    expect(result.stderr).toContain('working directory no longer exists');
  });

  it('says when the command itself is missing', async () => {
    const result = await runProcess(input(root), 'renkei-no-such-command', ['--version']);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('no such command on this worker');
  });

  it('proves at boot whether a uid drop works here, and says why when it cannot', async () => {
    const problem = await verifyUidIsolation();
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect(problem).toBeNull();
    } else {
      // Not root: setpriv (or its absence) explains itself.
      expect(problem).toEqual(expect.any(String));
      expect(problem).not.toBe('');
    }
  });

  it('proves at boot how a command can start with no network, and says why per mode when it cannot', async () => {
    const probe = await verifyNetworkIsolation();
    if (probe.mode === null) {
      // Neither way worked: each mode said so in so many words.
      expect(probe.problems).toHaveLength(2);
      for (const problem of probe.problems) expect(problem).toMatch(/^(netns|userns): .+/);
    } else {
      expect(['netns', 'userns']).toContain(probe.mode);
      // netns is tried first and needs root; a non-root worker can only reach userns.
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        expect(probe.mode).toBe('userns');
        expect(probe.problems).toEqual(['netns: this process is not root']);
      }
    }
  });
});

describe('directory permissions under a restrictive umask', () => {
  // The real worker raises its umask to 0077 before it ever touches the
  // workspaces volume, so a caller's uid reads nothing else it creates.
  // mkdir's `mode` option goes through that umask like any other
  // creation call — only chmod, applied after, is immune to it. Without
  // that chmod, /workspaces would end up 0700 (umask 0077 clears every
  // group/other bit from a requested 0711), sealing every caller's uid
  // out of a root it only needs to
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
});

describe('a cloned workspace', () => {
  const storageKey = 'subjecthash/ws-1';

  it('clones a repository and reports its branch', async () => {
    const outcome = await cloneRepository({
      storageKey,
      identity: null,
      cloneUrl: origin,
      gitProxy: {
        base: 'http://127.0.0.1:1/git/unused/bitbucket.org/',
        insteadOf: 'https://bitbucket.org/',
      },
      branch: '',
      depth: 0,
    });
    expect(outcome).toEqual({ ok: true, branch: 'main' });
    expect(
      (await readFile(join(workspaceDir(storageKey), 'README.md'), 'utf8')).startsWith('# Demo')
    ).toBe(true);
  });

  it('gives each chat a worktree of its own that cannot step on the base or another', async () => {
    const first = newWorkspaceStorageKey('subjecthash');
    const second = newWorkspaceStorageKey('subjecthash');
    const base = { baseStorageKey: storageKey, identity: null } as const;
    expect(await addWorktree({ ...base, storageKey: first, branch: 'renkei/one' })).toEqual({
      ok: true,
      branch: 'renkei/one',
    });
    expect(await addWorktree({ ...base, storageKey: second, branch: 'renkei/two' })).toEqual({
      ok: true,
      branch: 'renkei/two',
    });
    // The same branch cannot be started twice.
    const clash = await addWorktree({
      ...base,
      storageKey: 'subjecthash/clash',
      branch: 'renkei/one',
    });
    expect(clash.ok).toBe(false);
    await expect(stat(workspaceDir('subjecthash/clash'))).rejects.toThrow();

    await writeFile(join(workspaceDir(first), 'only-in-one.txt'), 'x');
    await expect(stat(join(workspaceDir(second), 'only-in-one.txt'))).rejects.toThrow();
    await expect(stat(join(workspaceDir(storageKey), 'only-in-one.txt'))).rejects.toThrow();
    expect(git(workspaceDir(first), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('renkei/one');
    // A commit in one worktree is on its branch alone.
    git(workspaceDir(first), 'add', '-A');
    git(workspaceDir(first), 'commit', '-m', 'only in one');
    expect(git(workspaceDir(first), 'log', '--format=%s', '-1').trim()).toBe('only in one');
    expect(git(workspaceDir(second), 'log', '--format=%s', '-1').trim()).not.toBe('only in one');
    expect(git(workspaceDir(storageKey), 'log', '--format=%s', '-1').trim()).not.toBe('only in one');
    expect(git(workspaceDir(storageKey), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD'); // detached, so a worktree may check out main;

    await removeWorktree(storageKey, first, null);
    await removeWorktree(null, second, null);
    expect(await checkoutExists(first)).toBe(false);
    expect(await checkoutExists(second)).toBe(false);
    expect(git(workspaceDir(storageKey), 'worktree', 'list', '--porcelain')).not.toContain(
      'renkei/one'
    );

    // The chat's branch outlives its worktree: asking again checks the same work out.
    const again = newWorkspaceStorageKey('subjecthash');
    expect(await addWorktree({ ...base, storageKey: again, branch: 'renkei/one' })).toEqual({
      ok: true,
      branch: 'renkei/one',
    });
    await removeWorktree(storageKey, again, null);
  });

  it('reports a clone that fails without leaving a directory', async () => {
    const outcome = await cloneRepository({
      storageKey: 'tenant-1/subjecthash/ws-bad',
      identity: null,
      cloneUrl: origin,
      gitProxy: {
        base: 'http://127.0.0.1:1/git/unused/bitbucket.org/',
        insteadOf: 'https://bitbucket.org/',
      },
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
    expect(Array.isArray(listed) && listed.map((entry) => entry.path)).not.toContain('.git');
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

  it('creates an empty folder with its missing parent directories', async () => {
    const dir = workspaceDir(storageKey);
    const made = await mkdirWorkspaceFile(dir, 'some_dir/some_other_dir', null);
    expect(made).toEqual({ created: true });
    expect((await stat(join(dir, 'some_dir', 'some_other_dir'))).isDirectory()).toBe(true);
    const again = await mkdirWorkspaceFile(dir, 'some_dir/some_other_dir', null);
    expect(again).toEqual({ created: false });
  });

  it('refuses to create a folder where a file already is', async () => {
    const dir = workspaceDir(storageKey);
    await writeWorkspaceFile(dir, 'scratch/taken.txt', 'x', null);
    await expect(mkdirWorkspaceFile(dir, 'scratch/taken.txt', null)).rejects.toBeInstanceOf(
      WorkspacePathError
    );
  });

  it('removes a file, then reports it already gone', async () => {
    const dir = workspaceDir(storageKey);
    await writeWorkspaceFile(dir, 'scratch/drop-me.txt', 'x', null);
    await expect(removeWorkspaceFile(dir, 'scratch/drop-me.txt')).resolves.toEqual({
      existed: true,
    });
    await expect(stat(join(dir, 'scratch', 'drop-me.txt'))).rejects.toThrow();
    await expect(removeWorkspaceFile(dir, 'scratch/drop-me.txt')).resolves.toEqual({
      existed: false,
    });
  });

  it('removes a folder recursively', async () => {
    const dir = workspaceDir(storageKey);
    await writeWorkspaceFile(dir, 'scratch/nested/a.txt', 'a', null);
    await writeWorkspaceFile(dir, 'scratch/nested/b.txt', 'b', null);
    await expect(removeWorkspaceFile(dir, 'scratch/nested')).resolves.toEqual({ existed: true });
    await expect(stat(join(dir, 'scratch', 'nested'))).rejects.toThrow();
  });

  it('refuses to remove the checkout root itself', async () => {
    const dir = workspaceDir(storageKey);
    await expect(removeWorkspaceFile(dir, '')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(removeWorkspaceFile(dir, '.')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('renames a file, creating a new parent directory as needed', async () => {
    const dir = workspaceDir(storageKey);
    await writeWorkspaceFile(dir, 'scratch/old-name.txt', 'content', null);
    await renameWorkspaceFile(dir, 'scratch/old-name.txt', 'scratch/moved/new-name.txt', null);
    await expect(stat(join(dir, 'scratch', 'old-name.txt'))).rejects.toThrow();
    expect(await readFile(join(dir, 'scratch', 'moved', 'new-name.txt'), 'utf8')).toBe('content');
  });

  it('refuses to rename onto an existing destination', async () => {
    const dir = workspaceDir(storageKey);
    await writeWorkspaceFile(dir, 'scratch/source.txt', 's', null);
    await writeWorkspaceFile(dir, 'scratch/taken.txt', 't', null);
    await expect(
      renameWorkspaceFile(dir, 'scratch/source.txt', 'scratch/taken.txt', null)
    ).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('refuses to rename a file that does not exist', async () => {
    const dir = workspaceDir(storageKey);
    await expect(
      renameWorkspaceFile(dir, 'scratch/nope.txt', 'scratch/elsewhere.txt', null)
    ).rejects.toBeInstanceOf(WorkspacePathError);
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

  it('interrupts every running command when the worker stops, and says so in the result', async () => {
    const dir = workspaceDir(storageKey);
    const started = Date.now();
    const run = runShell(
      { cwd: dir, home: homeDir(storageKey), identity: null, env: {}, timeoutMs: 30_000 },
      'echo begun; sleep 30; echo never'
    );
    // Let the shell start before pulling the rug.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(interruptRunningProcesses()).toBe(1);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain('begun');
    expect(result.stdout).not.toContain('never');
    expect(Date.now() - started).toBeLessThan(10_000);
    // Nothing left to interrupt; a finished command was never interrupted.
    expect(interruptRunningProcesses()).toBe(0);
    const after = await runShell(
      { cwd: dir, home: homeDir(storageKey), identity: null, env: {}, timeoutMs: 5_000 },
      'echo fine'
    );
    expect(after).toMatchObject({ exitCode: 0, interrupted: false, stdout: 'fine\n' });
  });
});
