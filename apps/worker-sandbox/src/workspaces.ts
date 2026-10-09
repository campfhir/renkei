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
 * HOME, a PATH and a few conveniences. No git token reaches the child: a
 * clone or a push goes through the delegate's git proxy, named in the
 * child's environment as a `url.<base>.insteadOf` config (`GIT_CONFIG_*`),
 * so nothing secret is in argv, in `.git/config`, or in the process at all.
 *
 * Network is the one thing not narrowed here: a project's own commands
 * (`pnpm install`, a test hitting a sandbox API) need the internet, and
 * the browser's egress proxy cannot be forced on an arbitrary process.
 * docs/sandbox-workspaces-design.md says what that means for placement.
 */

import { constants as fsConstants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
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
  /**
   * This worker was told to stop (interruptRunningProcesses) while the
   * command ran and killed its process tree: the command did not finish,
   * through no fault of its own, and can be run again.
   */
  interrupted: boolean;
  /** A stream grew past STREAM_CAP_BYTES and the rest was dropped. */
  truncated: boolean;
  durationMs: number;
}

/**
 * Every process runProcess has running right now, by the kill that ends
 * it. A worker shutting down (index.ts) calls interruptRunningProcesses
 * so each in-flight command answers `interrupted` instead of vanishing
 * with the process — the caller then gets a result that says what
 * happened rather than a dropped connection.
 */
const running = new Set<() => void>();

/**
 * Kills every running command's process tree, SIGTERM then SIGKILL after
 * the grace, and marks each result interrupted. Returns how many were
 * running. Idempotent: a second call finds nothing.
 */
export function interruptRunningProcesses(): number {
  const interrupt = [...running];
  running.clear();
  for (const kill of interrupt) kill();
  return interrupt.length;
}

/** The delegate's git proxy for one operation: `url.<base>.insteadOf = <insteadOf>`. */
export interface GitProxy {
  base: string;
  insteadOf: string;
}

/**
 * The proxy as the request carried it: an http(s) base ending in `/` and
 * an `insteadOf` that is one of the two hosts a workspace may live on.
 */
export function parseGitProxy(value: unknown): GitProxy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const base = typeof record.base === 'string' ? record.base : '';
  const insteadOf = typeof record.insteadOf === 'string' ? record.insteadOf : '';
  if (!/^https?:\/\/[^\s/]+\/git\/[^\s]+\/$/.test(base)) return null;
  if (insteadOf !== 'https://github.com/' && insteadOf !== 'https://bitbucket.org/') return null;
  return { base, insteadOf };
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
  /**
   * Where this one git process goes instead of its host: the delegate's
   * git proxy (docs/delegate-key-design.md), as `url.<base>.insteadOf`.
   * Passed to the child only; the ticket in `base` is worth one person's
   * grant on one host for a few minutes, and no token is ever here.
   */
  gitProxy?: GitProxy;
  /**
   * Fires when the caller no longer wants the result — the web app's
   * chat turn was stopped and its request went away. The process tree is
   * killed and the result marked `interrupted`, as on a worker stop.
   */
  signal?: AbortSignal;
  /**
   * Start the process in a network namespace of its own — a loopback
   * that is down and nothing else, so it can reach no host at all. A
   * script over a caller's files (scripts.ts) runs this way; a workspace
   * command, whose installs and tests need the internet, does not. Which
   * way the namespace is made is the boot probe's finding
   * (verifyNetworkIsolation); null is no isolation.
   */
  networkIsolation?: NetworkIsolation | null;
}

/**
 * How a process is cut off from the network:
 *  - `netns` — `unshare --net` as root, BEFORE the uid drop, so the dropped
 *    process holds no capability to undo it. Needs CAP_SYS_ADMIN, which
 *    Docker's default profile withholds.
 *  - `userns` — `unshare -Un` AFTER the drop, as the caller's uid: a user
 *    namespace of the caller's own (their uid mapped to itself inside) and
 *    a network namespace it owns. Needs unprivileged user namespaces, which
 *    the kernel allows by default but Docker's default seccomp profile
 *    also blocks; works without root too, so a developer's checkout can
 *    run scripts offline.
 * The boot probe tries them in this order and the first that proves out
 * is the one every run gets.
 */
export type NetworkIsolation = 'netns' | 'userns';

/** The modes the probe tries, most contained first. */
export const NETWORK_ISOLATION_MODES: readonly NetworkIsolation[] = ['netns', 'userns'];

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
  if (input.gitProxy) {
    // Config through the environment: not argv (visible in `ps`), not
    // .git/config (at rest on the volume) — the remote stays the real host
    // and only this one process is rerouted through the delegate.
    const count = Number(env.GIT_CONFIG_COUNT ?? '0');
    env.GIT_CONFIG_COUNT = String(count + 1);
    env[`GIT_CONFIG_KEY_${count}`] = `url.${input.gitProxy.base}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${count}`] = input.gitProxy.insteadOf;
  }
  return env;
}

/**
 * How a process is started: dropped to the caller's uid when this worker
 * can, plainly otherwise; and, when asked, inside its own empty network
 * namespace — made as root before the drop (`netns`: unshare, THEN
 * setpriv, so the dropped process can neither reach a host nor undo the
 * namespace), or as the caller after it (`userns`: setpriv, THEN
 * `unshare -Un` with the caller's uid mapped to itself, so the script
 * still sees its own uid). `netns` needs root and is ignored without an
 * identity; `userns` works either way.
 */
export function wrapCommand(
  identity: ExecIdentity | null,
  file: string,
  args: string[],
  networkIsolation: NetworkIsolation | null = null
): { file: string; args: string[] } {
  const inner =
    networkIsolation === 'userns'
      ? {
          file: 'unshare',
          args: [
            '-Un',
            `--map-user=${identity?.uid ?? process.getuid?.() ?? PROBE_UID}`,
            `--map-group=${identity?.gid ?? process.getgid?.() ?? PROBE_UID}`,
            '--',
            file,
            ...args,
          ],
        }
      : { file, args };
  if (!identity) return inner;
  const dropped = [
    'setpriv',
    `--reuid=${identity.uid}`,
    `--regid=${identity.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--',
    inner.file,
    ...inner.args,
  ];
  if (networkIsolation === 'netns') return { file: 'unshare', args: ['--net', '--', ...dropped] };
  return { file: dropped[0]!, args: dropped.slice(1) };
}

/** What the boot probe found: the mode every run gets, or why none works. */
export interface NetworkIsolationProbe {
  mode: NetworkIsolation | null;
  /** Each mode that failed, with what it said — for the operator and the log. */
  problems: string[];
}

/**
 * Prove, once at boot, how a command can be started with no network
 * here, trying each mode in NETWORK_ISOLATION_MODES order: a namespace
 * holding a loopback and nothing else is the proof. On a stock Docker
 * deployment neither works (`unshare --net` needs CAP_SYS_ADMIN and the
 * default seccomp profile blocks user namespaces too), and the result
 * says so per mode; what the worker then does with that is index.ts's
 * decision (fail closed, or the operator's explicit opt-in).
 */
export async function verifyNetworkIsolation(): Promise<NetworkIsolationProbe> {
  const problems: string[] = [];
  const identity = canIsolateByUid() ? { uid: PROBE_UID, gid: PROBE_UID } : null;
  for (const mode of NETWORK_ISOLATION_MODES) {
    if (mode === 'netns' && !identity) {
      problems.push('netns: this process is not root');
      continue;
    }
    const problem = await probeNetworkIsolation(mode, identity);
    if (problem === null) return { mode, problems };
    problems.push(`${mode}: ${problem}`);
  }
  return { mode: null, problems };
}

/** One mode's proof: null when a namespace held only a loopback, else what went wrong. */
export async function probeNetworkIsolation(
  mode: NetworkIsolation,
  identity: ExecIdentity | null
): Promise<string | null> {
  // /proc/self/net is the probe's OWN namespace; /sys/class/net would
  // still show the container's interfaces, since sysfs was mounted
  // from the namespace the container started in.
  const result = await runProcess(
    {
      cwd: '/',
      home: '/',
      identity,
      env: {},
      timeoutMs: 15_000,
      networkIsolation: mode,
    },
    'cat',
    ['/proc/self/net/dev']
  );
  const interfaces = result.stdout
    .split('\n')
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter(
      (name) => name && !/\s/.test(name) && !name.startsWith('Inter') && !name.startsWith('face')
    );
  if (result.exitCode === 0 && interfaces.length > 0 && interfaces.every((name) => name === 'lo')) {
    return null;
  }
  const said = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ');
  return said || `exit ${result.exitCode ?? 'none'}${result.signal ? ` (${result.signal})` : ''}`;
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
  if (file === 'setpriv' || file === 'unshare') {
    return `${error.message}: ${file} (util-linux) is not installed on this worker, so a command cannot be ${file === 'setpriv' ? "dropped to the caller's uid" : 'started without a network'}.`;
  }
  return `${error.message}: no such command on this worker.`;
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
  const wrapped = wrapCommand(input.identity, file, args, input.networkIsolation ?? null);
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let truncated = false;
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let child: ChildProcess;
    try {
      // The caller's own shell command is the feature here; what contains it
      // is the uid drop, the capability bounding set and the limits that
      // `wrapCommand` puts around it, not the command text.
      child = spawn(wrapped.file, wrapped.args, {
        // codeql[js/command-line-injection, js/indirect-command-line-injection]
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
        interrupted: false,
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
    const killTree = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, input.timeoutMs);
    const interrupt = (): void => {
      if (settled) return;
      interrupted = true;
      killTree();
    };
    running.add(interrupt);
    if (input.signal?.aborted) interrupt();
    else input.signal?.addEventListener('abort', interrupt, { once: true });

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      running.delete(interrupt);
      input.signal?.removeEventListener('abort', interrupt);
      return true;
    };
    const answer = (exitCode: number | null, signal: string | null, failure?: string): void =>
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout(),
        stderr: failure ? `${stderr()}\n${failure}` : stderr(),
        timedOut,
        interrupted,
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
  gitProxy: GitProxy;
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
    gitProxy: input.gitProxy,
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
  // One handle for the check and the read, so the file cannot be swapped
  // between them.
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return { error: `No such file: ${relativePath || '.'}` };
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory())
      return { error: `${relativePath || '.'} is a directory; list it instead.` };
    if (!info.isFile()) return { error: `${relativePath} is not a regular file.` };
    if (info.size > maxBytes) {
      return {
        error: `${relativePath} is ${info.size} bytes — too large to read here (limit ${maxBytes}).`,
      };
    }
    return { bytes: await handle.readFile(), sizeBytes: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Every ancestor directory between `path` and `root` that does not exist
 * yet, created and owned like the file/entry landing under them — the
 * write and the rename below share this, since both can land a path
 * under a folder that is not there yet.
 */
async function ensureParentDirs(
  path: string,
  root: string,
  identity: ExecIdentity | null
): Promise<void> {
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
}

/** The errno code of a thrown file-system error, or undefined for anything else. */
function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export async function writeWorkspaceFile(
  dir: string,
  relativePath: string,
  content: string | Buffer,
  identity: ExecIdentity | null
): Promise<{ created: boolean; sizeBytes: number }> {
  const path = await containedPath(dir, relativePath);
  // Parent directories the write creates belong to the caller like the file.
  const root = await realpath(dir);
  await ensureParentDirs(path, root, identity);
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  // Create exclusively first, else truncate in place; O_NOFOLLOW makes the
  // kernel refuse a symbolic link at the final component, so there is no
  // window between a check and the write for one to appear in.
  const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = fsConstants;
  let created = true;
  let handle;
  try {
    handle = await open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
    created = false;
    try {
      handle = await open(path, O_WRONLY | O_TRUNC | O_NOFOLLOW);
    } catch (inner) {
      const code = errnoCode(inner);
      if (code === 'ELOOP')
        throw new WorkspacePathError(
          `${relativePath} is a symbolic link; refusing to write through it.`
        );
      if (code === 'EISDIR') throw new WorkspacePathError(`${relativePath} is a directory.`);
      throw inner;
    }
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chownIf(path, identity);
  return { created, sizeBytes: bytes.byteLength };
}

/**
 * An empty directory created in the checkout — the trailing-`/` "New
 * file" convention's target. Shares `ensureParentDirs` with the write
 * path above, so a nested `some/deep/dir/` gets the same mkdir-p
 * semantics a nested file path already does; idempotent when the
 * directory is already there.
 */
export async function mkdirWorkspaceFile(
  dir: string,
  relativePath: string,
  identity: ExecIdentity | null
): Promise<{ created: boolean }> {
  const path = await containedPath(dir, relativePath);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new WorkspacePathError(
        `${relativePath} is a symbolic link; refusing to create a directory through it.`
      );
    if (!info.isDirectory())
      throw new WorkspacePathError(`${relativePath} already exists as a file.`);
    return { created: false };
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error;
  }
  const root = await realpath(dir);
  await ensureParentDirs(path, root, identity);
  await mkdir(path, { mode: 0o755 });
  await chownIf(path, identity);
  return { created: true };
}

/**
 * A file or folder removed from the checkout — recursively for a
 * directory. `{existed: false}` rather than an error when there was
 * nothing there: the tree's own idea of the checkout can be a beat
 * stale (a turn just ran), and re-deleting an already-gone path is not
 * a failure.
 */
export async function removeWorkspaceFile(
  dir: string,
  relativePath: string
): Promise<{ existed: boolean }> {
  const path = await containedPath(dir, relativePath);
  const root = await realpath(dir);
  if (path === root) throw new WorkspacePathError('Refusing to remove the checkout itself.');
  try {
    await lstat(path);
  } catch {
    return { existed: false };
  }
  await rm(path, { recursive: true, force: false });
  return { existed: true };
}

/**
 * A file or folder renamed or moved within the checkout — `fromRelative`
 * must already exist, `toRelative` must not (no silent overwrite), and
 * every missing ancestor directory `toRelative` needs is created first,
 * the same as a write landing under a new folder.
 */
export async function renameWorkspaceFile(
  dir: string,
  fromRelative: string,
  toRelative: string,
  identity: ExecIdentity | null
): Promise<void> {
  const from = await containedPath(dir, fromRelative);
  try {
    await lstat(from);
  } catch {
    throw new WorkspacePathError(`No such file or folder: ${fromRelative || '.'}`);
  }
  const to = await containedPath(dir, toRelative);
  if (to === from) return;
  try {
    await lstat(to);
    throw new WorkspacePathError(`${toRelative} already exists.`);
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error;
    // ENOENT — the destination is free, which is what a rename needs.
  }
  const root = await realpath(dir);
  await ensureParentDirs(to, root, identity);
  await rename(from, to);
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
    // Git's own — never browsed, edited or listed here; a chat's own git
    // tools are the way in, on the rare occasion one is needed at all.
    if (entry.name === '.git') continue;
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
