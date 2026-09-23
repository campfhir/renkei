/**
 * The workspace volume, git, and the processes a workspace runs — the
 * I/O half of code workspaces (the pure half is
 * @renkei/connector-sandbox's workspaces.ts; the HTTP surface is
 * workspace-endpoints.ts).
 *
 * Layout on the volume (SANDBOX_WORKSPACES_DIR, default /workspaces):
 *
 *   <root>/<tenantId>/<sha256(subject)>/            one caller, mode 0700
 *   <root>/<tenantId>/<sha256(subject)>/home/       their HOME — caches, dotfiles
 *   <root>/<tenantId>/<sha256(subject)>/<uuid>/     one checkout
 *
 * Every path is built from ids and a hash, never from a repository name;
 * caller-supplied paths inside a checkout are validated by
 * `validateWorkspacePath` and then resolved and checked again against
 * the checkout's real path, so a symlink in the repository cannot point a
 * read or a write outside it.
 *
 * WHO a command runs as is the boundary that matters most. When this
 * worker runs as root (the sandbox image does when workspaces are
 * enabled — docker/sandbox-entrypoint.sh), every process it starts for a
 * caller is dropped with setpriv to that caller's own unprivileged uid
 * (`execUidFor`: derived from their identity, stable, far above any
 * system account), with no supplementary groups, no capabilities, and
 * no-new-privs so a setuid binary cannot climb back. Their directory is
 * theirs (0700); every other caller's is another uid's; the staged-file
 * disk and this worker's own environment (its database URL, its bearer
 * keys) are root's. So a `cat` of another workspace, or of
 * /proc/<worker>/environ, is a permission error, not a leak. Without
 * root (a developer's checkout) commands run as the worker's own user,
 * and startup says so: that is fine for one person and wrong for a
 * shared deployment.
 *
 * A command's environment is built from nothing — never inherited from
 * this process — plus the caller's own variables (env-secrets.ts), a
 * HOME, a PATH and a few conveniences. The git token for a clone or a
 * push rides in the child's environment as an `http.extraheader` config
 * (`GIT_CONFIG_*`), so it is never in argv, never in `.git/config`, and
 * gone when that process exits.
 *
 * Network is the one thing not narrowed here: a project's own commands
 * (`pnpm install`, a test hitting a sandbox API) need the internet, and
 * the browser's egress proxy cannot be forced on an arbitrary process.
 * docs/sandbox-workspaces-design.md says what that means for placement.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  readFile as readFileBytes,
  realpath,
  rm,
  stat,
  writeFile as writeFileBytes,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  CLONE_TIMEOUT_MS,
  EXEC_MAX_FILE_BYTES,
  EXEC_MAX_PROCESSES,
  FIND_MAX_RESULTS,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  execUidFor,
  subjectSegmentOf,
} from '@renkei/connector-sandbox';
import { logger } from './logger';

let workspacesRoot = process.env.SANDBOX_WORKSPACES_DIR || '/workspaces';

/** Test-only override; production reads SANDBOX_WORKSPACES_DIR once at boot. */
export function setWorkspacesRootForTests(dir: string): void {
  workspacesRoot = dir;
}

export function getWorkspacesRoot(): string {
  return workspacesRoot;
}

/** Whether this process can drop a command to a caller's own uid. */
export function canIsolateByUid(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** An unprivileged uid no caller is ever given (`nobody`); the boot probe drops to it. */
const PROBE_UID = 65_534;

/**
 * Prove, once at boot, that dropping a command to another uid works here:
 * setpriv is installed, on the PATH a command gets, and this process holds
 * the capabilities the drop needs (CAP_SETUID, CAP_SETGID, CAP_SETPCAP).
 * Null when it does; otherwise what went wrong, for the operator. Without
 * this, a missing setpriv would surface only as `spawn setpriv ENOENT` on
 * every command a caller ever runs, and a container started without those
 * capabilities as a setpriv error on each — never at startup, where the
 * deployment can be fixed.
 */
export async function verifyUidIsolation(): Promise<string | null> {
  const result = await runProcess(
    {
      cwd: '/',
      home: '/',
      identity: { uid: PROBE_UID, gid: PROBE_UID },
      env: {},
      timeoutMs: 15_000,
    },
    'id',
    ['-u']
  );
  if (result.exitCode === 0 && result.stdout.trim() === String(PROBE_UID)) return null;
  const said = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ');
  return said || `exit ${result.exitCode ?? 'none'}${result.signal ? ` (${result.signal})` : ''}`;
}

/** The uid/gid a caller's processes run as — null when this worker is not root. */
export interface ExecIdentity {
  uid: number;
  gid: number;
}

export function identityFor(target: { tenantId: string; subject: string }): ExecIdentity | null {
  if (!canIsolateByUid()) return null;
  const uid = execUidFor(target.tenantId, target.subject);
  return { uid, gid: uid };
}

/** A fresh storage key for a new checkout — persisted on the row. */
export function newWorkspaceStorageKey(tenantId: string, subject: string): string {
  return join(tenantId, subjectSegmentOf(subject), randomUUID());
}

export function workspaceDir(storageKey: string): string {
  return join(workspacesRoot, storageKey);
}

function callerDir(storageKey: string): string {
  return dirname(workspaceDir(storageKey));
}

/**
 * Whether a checkout is still where its row says. A ready row can outlive
 * its bytes: a deployment that recreates the container without the
 * workspaces volume mounted loses every checkout, and a directory can be
 * removed by hand. Every command in such a checkout would otherwise fail
 * with a bare `spawn setpriv ENOENT` — Node's word for a working directory
 * that is not there, indistinguishable from a missing executable.
 */
export async function checkoutExists(storageKey: string): Promise<boolean> {
  return isDirectory(workspaceDir(storageKey));
}

/**
 * Whether this worker has the caller's directory at all — their home and
 * whatever checkouts they had. When a ready row's checkout is missing,
 * this tells two failures apart: a worker whose disk never held this
 * caller (one started without the workspaces volume mounted, or a second
 * instance behind the same address) from a checkout that was removed on
 * the disk that has everything else.
 */
export async function callerDirExists(storageKey: string): Promise<boolean> {
  return isDirectory(callerDir(storageKey));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** This worker, as a person reading a transcript or a log can tell one from another. */
export function workerInstance(): string {
  return hostname();
}

/** How long this process has been up, for the same reader. */
export function workerUptime(): string {
  const seconds = Math.floor(process.uptime());
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7_200) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function homeDir(storageKey: string): string {
  return join(callerDir(storageKey), 'home');
}

async function chownIf(path: string, identity: ExecIdentity | null): Promise<void> {
  if (identity) await chown(path, identity.uid, identity.gid);
}

export async function ensureWorkspacesRoot(): Promise<void> {
  // Traversable by everyone, listable by nobody but root: a caller's uid
  // reaches its own 0700 directory by name and nothing else. mkdir's
  // `mode` is only what the OS applies at creation time — it goes
  // through the process umask like any other creation call, and this
  // worker raises its umask to 0077 before it ever calls this (so
  // nothing else it creates, a log or a lock, is readable by a caller's
  // uid). 0711 under a 0077 umask becomes 0700, which would seal every
  // caller's uid out of the root it needs to just walk through, so the
  // mode is set again with chmod, which — unlike mkdir — always applies
  // exactly what it is given, regardless of umask.
  await mkdir(workspacesRoot, { recursive: true, mode: 0o711 });
  await chmod(workspacesRoot, 0o711);
}

/** The caller's directory and home, owned by their uid, ahead of a clone. */
export async function ensureCallerDirs(
  storageKey: string,
  identity: ExecIdentity | null
): Promise<void> {
  const caller = callerDir(storageKey);
  const tenantDir = dirname(caller);
  // Same traversable-not-listable shape, and the same umask hazard, as
  // the workspaces root above.
  await mkdir(tenantDir, { recursive: true, mode: 0o711 });
  await chmod(tenantDir, 0o711);
  await mkdir(caller, { recursive: true, mode: 0o700 });
  await chownIf(caller, identity);
  const home = homeDir(storageKey);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chownIf(home, identity);
}

// ─── Running things ─────────────────────────────────────────────────────────

/**
 * The system PATH plus the toolchains the sandbox image installs
 * outside it (docker/Dockerfile, target sandbox): Go under /usr/local/go
 * and the Rust toolchain's proxies under /usr/local/cargo. Absent
 * directories on a developer's machine cost nothing.
 */
const SYSTEM_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/usr/local/cargo/bin';
/** Where the image keeps the Rust toolchains, read-only to every caller. */
const RUSTUP_HOME = '/usr/local/rustup';
/** Bytes of each stream kept in memory; beyond this the stream is dropped and the result says so. */
const STREAM_CAP_BYTES = 4 * 1_048_576;
const KILL_GRACE_MS = 2_000;

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The wall-clock limit fired and the process tree was killed. */
  timedOut: boolean;
  /** A stream grew past STREAM_CAP_BYTES and the rest was dropped. */
  truncated: boolean;
  durationMs: number;
}

export interface RunInput {
  cwd: string;
  home: string;
  identity: ExecIdentity | null;
  /** The caller's own variables — the ONLY thing inherited into the child besides what this builds. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Extra variables this worker sets for one call (git plumbing); win over the caller's. */
  extraEnv?: Record<string, string>;
  /** Passed to the child only, never logged: a git credential header. */
  gitAuthHeader?: string;
}

/** The environment a caller's process starts with, built from nothing. */
export function childEnvironment(input: RunInput): Record<string, string> {
  const env: Record<string, string> = {
    ...input.env,
    PATH: `${input.home}/.local/bin:${SYSTEM_PATH}`,
    HOME: input.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    // Tooling that changes behaviour under CI is usually what a non-interactive run wants.
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Package managers cache under HOME (npm reads npm_config_cache; pnpm its store) so a
    // second install is fast and nothing lands outside the caller's tree.
    npm_config_cache: `${input.home}/.npm`,
    // The other toolchains' caches and per-user state, likewise under
    // HOME: Go's module cache and build cache, cargo's registry, and the
    // XDG cache the language servers (jdtls, clangd) index into. Rustup's
    // toolchains are the image's, shared read-only.
    XDG_CACHE_HOME: `${input.home}/.cache`,
    GOPATH: `${input.home}/go`,
    GOCACHE: `${input.home}/.cache/go-build`,
    CARGO_HOME: `${input.home}/.cargo`,
    RUSTUP_HOME,
    ...(input.extraEnv ?? {}),
  };
  if (input.gitAuthHeader) {
    // Config through the environment: not argv (visible in `ps`), not
    // .git/config (at rest on the volume). One entry, scoped to the host.
    const count = Number(env.GIT_CONFIG_COUNT ?? '0');
    env.GIT_CONFIG_COUNT = String(count + 1);
    env[`GIT_CONFIG_KEY_${count}`] = 'http.https://bitbucket.org/.extraheader';
    env[`GIT_CONFIG_VALUE_${count}`] = `Authorization: ${input.gitAuthHeader}`;
  }
  return env;
}

/** How a process is started: dropped to the caller's uid when this worker can, plainly otherwise. */
export function wrapCommand(
  identity: ExecIdentity | null,
  file: string,
  args: string[]
): { file: string; args: string[] } {
  if (!identity) return { file, args };
  return {
    file: 'setpriv',
    args: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      '--clear-groups',
      '--no-new-privs',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--',
      file,
      ...args,
    ],
  };
}

/**
 * The shell prelude every command runs behind: process and file-size
 * limits (per uid, so a fork bomb stops at the caller's own ceiling), no
 * core dumps. Failures to lower a limit are ignored — a developer's
 * checkout may already sit under one.
 */
export function shellPrelude(): string {
  const fileKb = Math.floor(EXEC_MAX_FILE_BYTES / 1024);
  return `ulimit -u ${EXEC_MAX_PROCESSES} -f ${fileKb} -c 0 2>/dev/null\n`;
}

/**
 * What a spawn that never started should say. Node reports a working
 * directory that no longer exists with the same `spawn <file> ENOENT` as
 * an executable it cannot find, and for a command dropped through setpriv
 * the file named is always setpriv — so the bare message says nothing
 * about which it was. Only one of the two is worth saying.
 */
async function spawnFailure(
  cwd: string,
  file: string,
  error: NodeJS.ErrnoException
): Promise<string> {
  if (error.code !== 'ENOENT') return error.message;
  try {
    await stat(cwd);
  } catch {
    return `${error.message}: the working directory no longer exists on disk.`;
  }
  return file === 'setpriv'
    ? `${error.message}: setpriv (util-linux) is not installed on this worker, so a command cannot be dropped to the caller's uid.`
    : `${error.message}: no such command on this worker.`;
}

function collect(
  child: ChildProcess,
  stream: 'stdout' | 'stderr',
  onTruncate: () => void
): () => string {
  const chunks: Buffer[] = [];
  let total = 0;
  let dropped = false;
  child[stream]?.on('data', (chunk: Buffer) => {
    if (dropped) return;
    total += chunk.byteLength;
    if (total > STREAM_CAP_BYTES) {
      dropped = true;
      onTruncate();
      return;
    }
    chunks.push(chunk);
  });
  return () => Buffer.concat(chunks).toString('utf8');
}

/** Spawn one process, kill its whole group on timeout, and answer both streams. */
export function runProcess(input: RunInput, file: string, args: string[]): Promise<RunResult> {
  const wrapped = wrapCommand(input.identity, file, args);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(wrapped.file, wrapped.args, {
        cwd: input.cwd,
        env: childEnvironment(input),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a timeout can kill everything the
        // command started rather than only the shell.
        detached: true,
      });
    } catch (error) {
      resolvePromise({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        truncated: false,
        durationMs: Date.now() - started,
      });
      return;
    }
    const stdout = collect(child, 'stdout', () => (truncated = true));
    const stderr = collect(child, 'stderr', () => (truncated = true));

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    }, input.timeoutMs);

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const answer = (exitCode: number | null, signal: string | null, failure?: string): void =>
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout(),
        stderr: failure ? `${stderr()}\n${failure}` : stderr(),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    // A spawn that fails emits 'error' and then 'close' (with a negative
    // code): the first settles the result, synchronously, and only then
    // is what to say about it worked out.
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (!settle()) return;
      void spawnFailure(input.cwd, wrapped.file, error).then((failure) =>
        answer(null, null, failure)
      );
    });
    child.on('close', (code, signal) => {
      if (settle()) answer(code, signal);
    });
  });
}

/** A shell command in the workspace, behind the prelude. */
export function runShell(input: RunInput, command: string): Promise<RunResult> {
  return runProcess(input, 'bash', ['-c', `${shellPrelude()}${command}`]);
}

/** One git invocation, no shell in between. */
export function runGit(input: RunInput, args: string[]): Promise<RunResult> {
  return runProcess(input, 'git', args);
}

// ─── Clone, commit, push ────────────────────────────────────────────────────

export interface CloneInput {
  storageKey: string;
  identity: ExecIdentity | null;
  cloneUrl: string;
  authHeader: string;
  /** Empty means the repository's default branch. */
  branch: string;
  /** 0 means the whole history. */
  depth: number;
}

export type CloneOutcome = { ok: true; branch: string } | { ok: false; message: string };

/** Git's stderr, with anything that could carry a credential or a full URL trimmed to its last lines. */
function gitFailure(result: RunResult, fallback: string): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Cloning into') && !/^\s*\d+%/.test(line));
  const tail = lines.slice(-4).join(' ');
  return (tail || fallback).slice(0, 600);
}

export async function cloneRepository(input: CloneInput): Promise<CloneOutcome> {
  await ensureCallerDirs(input.storageKey, input.identity);
  const dir = workspaceDir(input.storageKey);
  const run: RunInput = {
    cwd: callerDir(input.storageKey),
    home: homeDir(input.storageKey),
    identity: input.identity,
    env: {},
    timeoutMs: CLONE_TIMEOUT_MS,
    gitAuthHeader: input.authHeader,
  };
  const args = ['clone', '--no-tags'];
  if (input.depth > 0) args.push('--depth', String(input.depth), '--no-single-branch');
  if (input.branch) args.push('--branch', input.branch);
  args.push('--', input.cloneUrl, dir);
  const cloned = await runGit(run, args);
  if (cloned.timedOut) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, message: 'The clone did not finish within its time limit.' };
  }
  if (cloned.exitCode !== 0) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, message: gitFailure(cloned, 'git clone failed') };
  }
  const head = await runGit({ ...run, cwd: dir }, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = head.exitCode === 0 ? head.stdout.trim() : input.branch;
  return { ok: true, branch: branch || 'HEAD' };
}

/** Bytes under a checkout — `du`, which counts what the filesystem does. */
export async function measureWorkspace(dir: string): Promise<number> {
  const measured = await runProcess(
    { cwd: dir, home: dir, identity: null, env: {}, timeoutMs: 60_000 },
    'du',
    ['-sk', '--', dir]
  );
  const kb = Number(measured.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/**
 * A storage key names exactly one checkout: tenant, caller hash, checkout
 * id. Anything else (an empty key, one that climbs) would make the
 * recursive removal below reach for a caller's whole directory or the
 * volume itself, so it is refused rather than trusted.
 */
export function isCheckoutStorageKey(storageKey: string): boolean {
  const segments = storageKey.split('/');
  return (
    segments.length === 3 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

/**
 * How long past its expiry a row whose bytes are on no instance's disk
 * waits before any instance drops it. With several sandbox instances each
 * sweeping the shared rows, an expired row whose checkout or file is on
 * ANOTHER instance's disk must be left for that instance — it alone can
 * remove the bytes. A row nobody claims within this grace has no bytes
 * anywhere (the disk was replaced, the directory removed) and goes.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60_000;

export function orphanedByNow(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() + ORPHAN_GRACE_MS < now;
}

export async function removeWorkspace(storageKey: string): Promise<void> {
  if (!isCheckoutStorageKey(storageKey)) {
    throw new Error(
      `refusing to remove a workspace with a malformed storage key: ${JSON.stringify(storageKey)}`
    );
  }
  await rm(workspaceDir(storageKey), { recursive: true, force: true });
}

// ─── Files ──────────────────────────────────────────────────────────────────

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/**
 * The real path of a workspace-relative path, proven to lie inside the
 * checkout after symlinks are resolved. For a path that does not exist
 * yet (a new file), the nearest existing ancestor is what must resolve
 * inside. Throws WorkspacePathError otherwise.
 */
export async function containedPath(dir: string, relativePath: string): Promise<string> {
  const root = await realpath(dir);
  const candidate = resolve(root, relativePath);
  let probe = candidate;
  let missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      const inside = real === root || real.startsWith(`${root}${sep}`);
      if (!inside) throw new WorkspacePathError('That path resolves outside the workspace.');
      return missing.length ? join(real, ...missing) : real;
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      const parent = dirname(probe);
      if (parent === probe)
        throw new WorkspacePathError('That path resolves outside the workspace.');
      missing = [probe.slice(parent.length + 1), ...missing];
      probe = parent;
    }
  }
}

export interface ReadOutcome {
  bytes: Buffer;
  sizeBytes: number;
}

export async function readWorkspaceFile(
  dir: string,
  relativePath: string,
  maxBytes: number
): Promise<ReadOutcome | { error: string }> {
  const path = await containedPath(dir, relativePath);
  let info;
  try {
    info = await stat(path);
  } catch {
    return { error: `No such file: ${relativePath || '.'}` };
  }
  if (info.isDirectory())
    return { error: `${relativePath || '.'} is a directory; list it instead.` };
  if (!info.isFile()) return { error: `${relativePath} is not a regular file.` };
  if (info.size > maxBytes) {
    return {
      error: `${relativePath} is ${info.size} bytes — too large to read here (limit ${maxBytes}).`,
    };
  }
  return { bytes: await readFileBytes(path), sizeBytes: info.size };
}

export async function writeWorkspaceFile(
  dir: string,
  relativePath: string,
  content: string | Buffer,
  identity: ExecIdentity | null
): Promise<{ created: boolean; sizeBytes: number }> {
  const path = await containedPath(dir, relativePath);
  let created = true;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new WorkspacePathError(
        `${relativePath} is a symbolic link; refusing to write through it.`
      );
    if (info.isDirectory()) throw new WorkspacePathError(`${relativePath} is a directory.`);
    created = false;
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error;
  }
  // Parent directories the write creates belong to the caller like the file.
  const root = await realpath(dir);
  const parents: string[] = [];
  for (
    let parent = dirname(path);
    parent !== root && parent.startsWith(root);
    parent = dirname(parent)
  ) {
    try {
      await stat(parent);
      break;
    } catch {
      parents.unshift(parent);
    }
  }
  for (const parent of parents) {
    await mkdir(parent, { mode: 0o755 });
    await chownIf(parent, identity);
  }
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  await writeFileBytes(path, bytes, { mode: 0o644 });
  await chownIf(path, identity);
  return { created, sizeBytes: bytes.byteLength };
}

export interface FileEntry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  sizeBytes: number | null;
}

/** The entries of one directory, shallow — for looking around. */
export async function listDirectory(
  dir: string,
  relativePath: string
): Promise<FileEntry[] | { error: string }> {
  const path = await containedPath(dir, relativePath);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return { error: `No such directory: ${relativePath || '.'}` };
  }
  const listed: FileEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listed.push({ path: entryPath, kind: 'dir', sizeBytes: null });
    else if (entry.isSymbolicLink())
      listed.push({ path: entryPath, kind: 'link', sizeBytes: null });
    else if (entry.isFile()) {
      let size: number | null = null;
      try {
        size = (await stat(join(path, entry.name))).size;
      } catch {
        // Vanished between readdir and stat; listed without a size.
      }
      listed.push({ path: entryPath, kind: 'file', sizeBytes: size });
    } else listed.push({ path: entryPath, kind: 'other', sizeBytes: null });
  }
  return listed;
}

export interface FindInput {
  dir: string;
  home: string;
  identity: ExecIdentity | null;
  glob: string;
  max?: number;
}

/**
 * Files matching a glob, as ripgrep lists them: .gitignore honoured, so
 * node_modules and build output stay out of the way unless the glob
 * names them. Run as the caller, like every command.
 */
export async function findFiles(
  input: FindInput
): Promise<{ paths: string[]; truncated: boolean } | { error: string }> {
  const max = input.max ?? FIND_MAX_RESULTS;
  const result = await runProcess(
    { cwd: input.dir, home: input.home, identity: input.identity, env: {}, timeoutMs: 60_000 },
    'rg',
    ['--files', '--sort', 'path', '--glob', input.glob, '--', '.']
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return { error: gitFailure(result, 'The file search failed.') };
  }
  const paths = result.stdout
    .split('\n')
    .map((line) => line.replace(/^\.\//, ''))
    .filter(Boolean);
  return { paths: paths.slice(0, max), truncated: paths.length > max };
}

export interface GrepInput extends FindInput {
  pattern: string;
  path: string;
  caseInsensitive: boolean;
  fixedStrings: boolean;
  glob: string;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export async function grepFiles(
  input: GrepInput
): Promise<{ matches: GrepMatch[]; truncated: boolean } | { error: string }> {
  const max = input.max ?? GREP_MAX_MATCHES;
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-columns',
    String(GREP_MAX_LINE_CHARS),
    '--max-columns-preview',
    '--sort',
    'path',
  ];
  if (input.caseInsensitive) args.push('--ignore-case');
  if (input.fixedStrings) args.push('--fixed-strings');
  if (input.glob && input.glob !== '**/*') args.push('--glob', input.glob);
  args.push('--regexp', input.pattern, '--', input.path || '.');
  const result = await runProcess(
    { cwd: input.dir, home: input.home, identity: input.identity, env: {}, timeoutMs: 60_000 },
    'rg',
    args
  );
  if (result.exitCode === 1) return { matches: [], truncated: false };
  if (result.exitCode !== 0) return { error: gitFailure(result, 'The search failed.') };
  const matches: GrepMatch[] = [];
  let truncated = false;
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const parsed = line.match(/^(.*?):(\d+):(.*)$/);
    if (!parsed) continue;
    if (matches.length >= max) {
      truncated = true;
      break;
    }
    matches.push({
      path: parsed[1]!.replace(/^\.\//, ''),
      line: Number(parsed[2]),
      text: parsed[3]!,
    });
  }
  return { matches, truncated };
}

/** A path relative to the checkout, for messages — never the absolute one. */
export function relativeTo(dir: string, path: string): string {
  return relative(dir, path);
}

export function isDebugEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.SANDBOX_WORKSPACES_DEBUG ?? '').trim());
}

export function logWorkspace(message: string, fields: Record<string, unknown>): void {
  logger.info(message, { component: 'worker-sandbox/workspaces', ...fields });
}
