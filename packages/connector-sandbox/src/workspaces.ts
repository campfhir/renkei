/**
 * Code workspaces — a repository a person cloned into the sandbox so a
 * model can work in it the way a developer would: list and search files,
 * read and edit them, run the project's own commands, commit and push.
 * The pure half: bounds, the vocabulary the worker and the web app both
 * speak, and the validators that keep a caller-supplied path, ref, name
 * or command inside the lines. Disk, git and processes are
 * apps/worker-sandbox's (src/workspaces.ts); the tools and the UI are
 * apps/web's; both go through exactly this code so a bad path is refused
 * the same way everywhere.
 *
 * Environment secrets ride alongside: variables a person hands their
 * commands (`NPM_TOKEN`, `DATABASE_URL` for a test database) that the
 * worker puts in a command's environment and NOWHERE else — the model
 * sees names, and every value is scrubbed from every output the worker
 * returns (`scrubSecretValues`, the browser secrets' own discipline).
 */

import { createHash } from 'node:crypto';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Workspaces one (tenantId, subject) may hold at once. */
export const WORKSPACE_MAX_PER_SUBJECT = 3;

/** A checkout's lifetime since its last use; the worker's sweep removes it after. */
export const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

/** What one checkout may grow to before further work is refused. */
export const WORKSPACE_MAX_BYTES = 2 * 1_073_741_824; // 2GB

/** Commits fetched by default — a shallow clone is what most tasks need; `depth: 0` asks for everything. */
export const CLONE_DEFAULT_DEPTH = 100;
export const CLONE_TIMEOUT_MS = 10 * 60_000;

export const EXEC_DEFAULT_TIMEOUT_MS = 2 * 60_000;
export const EXEC_MAX_TIMEOUT_MS = 10 * 60_000;
export const EXEC_COMMAND_MAX_CHARS = 8_000;
/** Output a command may answer with; longer output keeps its head and tail and says so. */
export const EXEC_OUTPUT_DEFAULT_CHARS = 30_000;
export const EXEC_OUTPUT_MAX_CHARS = 100_000;
/** Processes one caller's command tree may hold (RLIMIT_NPROC, per uid). */
export const EXEC_MAX_PROCESSES = 512;
/** The largest file a command may write (RLIMIT_FSIZE), in bytes. */
export const EXEC_MAX_FILE_BYTES = 512 * 1_048_576;

export const READ_DEFAULT_CHARS = 60_000;
export const READ_MAX_CHARS = 200_000;
/** A file the read tool refuses outright — a binary or a bundle is not something to read as text. */
export const READ_MAX_BYTES = 4 * 1_048_576;
export const WRITE_MAX_CHARS = 1_000_000;
export const FIND_MAX_RESULTS = 500;
export const GREP_MAX_MATCHES = 200;
export const GREP_MAX_LINE_CHARS = 400;
export const GREP_PATTERN_MAX_CHARS = 512;
export const GIT_OUTPUT_MAX_CHARS = 40_000;
export const COMMIT_MESSAGE_MAX_CHARS = 4_000;

export const PATH_MAX_CHARS = 1_024;
export const GIT_REF_MAX_CHARS = 200;

// ─── Environment secrets ────────────────────────────────────────────────────

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const ENV_VALUE_MAX_CHARS = 8_192;
/** Variables one (tenantId, subject) may hold at once. */
export const ENV_MAX_PER_SUBJECT = 50;

/**
 * Names a person's variable may not take, because the worker sets them
 * itself and a caller-controlled value would change what runs rather than
 * what it is told: the loader and shell knobs that would let a value
 * reach into the worker's own processes, and the git plumbing the worker
 * uses to carry a token to a clone or push.
 */
const ENV_RESERVED_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TMPDIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'IFS',
  'NODE_OPTIONS',
  'PYTHONSTARTUP',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_TERMINAL_PROMPT',
]);

export function validateEnvName(
  input: unknown
): { ok: true; name: string } | { ok: false; message: string } {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!ENV_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message:
        'A variable name is upper-case letters, digits and underscores, starting with a letter or underscore (at most 64 characters).',
    };
  }
  if (
    ENV_RESERVED_NAMES.has(name) ||
    name.startsWith('GIT_CONFIG_') ||
    name.startsWith('RENKEI_')
  ) {
    return { ok: false, message: `${name} is set by the sandbox itself and cannot be overridden.` };
  }
  return { ok: true, name };
}

export function validateEnvValue(
  input: unknown
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof input !== 'string') return { ok: false, message: 'A value is required.' };
  if (input.length === 0) return { ok: false, message: 'A value is required.' };
  if (input.length > ENV_VALUE_MAX_CHARS) {
    return { ok: false, message: `A value is at most ${ENV_VALUE_MAX_CHARS} characters.` };
  }
  if (input.includes('\0')) return { ok: false, message: 'A value cannot contain a null byte.' };
  return { ok: true, value: input };
}

// ─── Workspaces ─────────────────────────────────────────────────────────────

export type WorkspaceStatus = 'cloning' | 'ready' | 'failed';

/** One workspace as the store and the worker both describe it. */
export interface SandboxWorkspaceSummary {
  id: string;
  /** The grant provider the checkout came from — `atlassian-bitbucket` today. */
  provider: string;
  /** `workspace/repo`, as the provider names it. */
  repoFullName: string;
  branch: string;
  status: WorkspaceStatus;
  /** Why the clone failed, when it did. */
  error: string | null;
  sizeBytes: number;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export const WORKSPACE_PROVIDERS = ['atlassian-bitbucket'] as const;
export type WorkspaceProvider = (typeof WORKSPACE_PROVIDERS)[number];

export function isWorkspaceProvider(value: unknown): value is WorkspaceProvider {
  return typeof value === 'string' && WORKSPACE_PROVIDERS.some((provider) => provider === value);
}

/** `workspace/repo` — two slug halves, the shape Bitbucket's own URLs use. */
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function validateRepoFullName(
  input: unknown
):
  | { ok: true; fullName: string; workspace: string; repoSlug: string }
  | { ok: false; message: string } {
  const fullName = typeof input === 'string' ? input.trim() : '';
  if (!REPO_FULL_NAME_PATTERN.test(fullName) || fullName.includes('..')) {
    return {
      ok: false,
      message: 'A repository is named workspace/repo-slug, e.g. "acme/billing-service".',
    };
  }
  const [workspace, repoSlug] = fullName.split('/');
  return { ok: true, fullName, workspace: workspace!, repoSlug: repoSlug! };
}

/**
 * A branch or tag name a caller may pass to git. Git's own rules
 * (check-ref-format) are looser and stranger than this; the aim is a name
 * that can never read as an option (`-`), a path escape, or a ref-spec
 * with intent (`:`, `^`, `~`, `..`).
 */
export function validateGitRef(
  input: unknown
): { ok: true; ref: string } | { ok: false; message: string } {
  const ref = typeof input === 'string' ? input.trim() : '';
  if (
    !ref ||
    ref.length > GIT_REF_MAX_CHARS ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.lock') ||
    ref.endsWith('.') ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('@{') ||
    // Control characters are exactly what a ref must never carry.
    // eslint-disable-next-line no-control-regex
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)
  ) {
    return { ok: false, message: `"${ref || '(empty)'}" is not a usable branch name.` };
  }
  return { ok: true, ref };
}

/**
 * A path inside the workspace: relative, forward slashes, no traversal,
 * normalized (`./a//b/` → `a/b`). The empty path (or `.`) is the root.
 * Writes additionally refuse the `.git` directory (`forWrite`): a model
 * editing git's own state by hand is never what a task means.
 */
export function validateWorkspacePath(
  input: unknown,
  options: { forWrite?: boolean } = {}
): { ok: true; path: string } | { ok: false; message: string } {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw.length > PATH_MAX_CHARS) return { ok: false, message: 'That path is too long.' };
  if (raw.includes('\0') || raw.includes('\\')) {
    return { ok: false, message: 'A path uses forward slashes and no control characters.' };
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, message: 'A path is relative to the workspace root, not absolute.' };
  }
  const parts: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      return { ok: false, message: 'A path cannot leave the workspace ("..").' };
    }
    parts.push(segment);
  }
  const path = parts.join('/');
  if (options.forWrite && (parts[0] === '.git' || path === '.git')) {
    return { ok: false, message: 'Files under .git are git’s own; use the git tools instead.' };
  }
  return { ok: true, path };
}

export function validateCommand(
  input: unknown
): { ok: true; command: string } | { ok: false; message: string } {
  const command = typeof input === 'string' ? input : '';
  if (!command.trim()) return { ok: false, message: 'A command is required.' };
  if (command.length > EXEC_COMMAND_MAX_CHARS) {
    return { ok: false, message: `A command is at most ${EXEC_COMMAND_MAX_CHARS} characters.` };
  }
  if (command.includes('\0'))
    return { ok: false, message: 'A command cannot contain a null byte.' };
  return { ok: true, command };
}

/** Bound a caller's timeout request to what one tool call may wait for. */
export function execTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return EXEC_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(value)));
}

export function outputCharsOf(value: unknown, fallback = EXEC_OUTPUT_DEFAULT_CHARS): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(EXEC_OUTPUT_MAX_CHARS, Math.max(200, Math.floor(value)));
}

/**
 * Keep the head and the tail of an over-long output. A build log's
 * interesting lines are at the end (the error) and the start (what ran);
 * the middle is the part a person scrolls past.
 */
export function clipOutput(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(text.length - tail)}`,
    clipped: true,
  };
}

// ─── Identity on disk ───────────────────────────────────────────────────────

/** Where per-caller uids start; nothing on a stock image lives up there. */
export const EXEC_UID_BASE = 100_000;
/** How many uids the derivation spreads callers across. */
export const EXEC_UID_SPAN = 1_000_000_000;

/**
 * The unprivileged uid a caller's commands run as, derived from their
 * identity so it is stable across restarts and workspaces without a
 * table: files a command writes belong to this uid, other callers'
 * workspaces (mode 0700, other uids) are unreadable from it, and the
 * environment of one caller's process is not another's to read. A
 * collision between two callers would merely put them in one uid — the
 * span makes that a rounding error, not a plan.
 */
export function execUidFor(tenantId: string, subject: string): number {
  const digest = createHash('sha256').update(`${tenantId}\n${subject}`).digest();
  // Eight bytes are plenty for a modulus far below 2^53.
  const value = Number(digest.readBigUInt64BE(0) % BigInt(EXEC_UID_SPAN));
  return EXEC_UID_BASE + value;
}

/** The on-disk name of one caller — a hash, never the subject itself. */
export function subjectSegmentOf(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

/** A glob for `find`: bounded, no traversal, no absolute paths. */
export function validateGlob(
  input: unknown
): { ok: true; glob: string } | { ok: false; message: string } {
  const glob = typeof input === 'string' ? input.trim() : '';
  if (!glob) return { ok: true, glob: '**/*' };
  if (glob.length > PATH_MAX_CHARS || glob.includes('\0') || glob.includes('\\')) {
    return { ok: false, message: 'A glob uses forward slashes and no control characters.' };
  }
  if (glob.startsWith('/') || glob.split('/').includes('..')) {
    return { ok: false, message: 'A glob is relative to the workspace root and cannot leave it.' };
  }
  return { ok: true, glob: glob.replace(/^(\.\/)+/, '') };
}

export function validateGrepPattern(
  input: unknown
): { ok: true; pattern: string } | { ok: false; message: string } {
  const pattern = typeof input === 'string' ? input : '';
  if (!pattern) return { ok: false, message: 'A search pattern is required.' };
  if (pattern.length > GREP_PATTERN_MAX_CHARS) {
    return { ok: false, message: `A pattern is at most ${GREP_PATTERN_MAX_CHARS} characters.` };
  }
  if (pattern.includes('\0'))
    return { ok: false, message: 'A pattern cannot contain a null byte.' };
  return { ok: true, pattern };
}

/** Text that is not text: a NUL in the first 8k is how `grep` decides too. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8_192);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}
