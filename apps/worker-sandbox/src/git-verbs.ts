/**
 * The rest of git, as bounded verbs: the history (`git-log`), the remote
 * (`git-fetch`), branches (`git-branch`), rewriting and joining history
 * (`git-rebase`, `git-merge`), undoing (`git-reset`, `git-stash`,
 * `git-clean`) and narrowing a checkout (`git-sparse-checkout`). Each is
 * dispatched from workspace-endpoints.ts beside status, diff, commit,
 * push and pull, under the same three rules: the caller's row first, text
 * out scrubbed, a credential riding one request. Every argument a caller
 * supplies passes a validator from @renkei/connector-sandbox before git
 * sees it — a revision is a name or a hash with `~N`/`^N` steps and never
 * an option; a path is inside the checkout; a stash is a position.
 *
 * Rebase and merge are the two that can leave the checkout half-done.
 * They answer the operation's state rather than failing: `inProgress`
 * names it and `conflicts` the files, so a model resolves the conflicts
 * with the file tools and continues, skips or aborts with the same verb —
 * the way a developer finishes a rebase. Nothing here ever opens an
 * editor: GIT_EDITOR and GIT_SEQUENCE_EDITOR are `true`, so a message
 * git would have asked for is taken as it is.
 */

import type { ServerResponse } from 'node:http';
import {
  DIFF_MAX_CHARS,
  GIT_LOG_DEFAULT_COUNT,
  GIT_LOG_MAX_COUNT,
  GIT_OUTPUT_MAX_CHARS,
  clipOutput,
  parseCleanOutput,
  validateGitLogFilter,
  validateGitRange,
  validateGitRef,
  validateGitRevision,
  validateSparsePaths,
  validateStashIndex,
  validateStashMessage,
  validateWorkspacePath,
  type GitOperation,
} from '@renkei/connector-sandbox';
import { isRecord } from '@renkei/guards';
import type { StoredWorkspace } from './workspace-store';
import { scrubEnv, type OpenedEnv } from './env-secrets';
import { parseGitProxy, runGit, type RunInput, type RunResult } from './workspaces';
import { logErrorResponse } from './request-log';

type Body = Record<string, unknown>;

export type WorkspaceVerb = (
  workspace: StoredWorkspace,
  env: OpenedEnv,
  body: Body,
  response: ServerResponse
) => Promise<void>;

/** What the verbs borrow from workspace-endpoints.ts: how a git process is built and the row kept current. */
export interface GitVerbContext {
  runInputFor(
    workspace: StoredWorkspace,
    env: OpenedEnv,
    timeoutMs: number,
    extra?: Partial<RunInput>
  ): RunInput;
  currentBranch(workspace: StoredWorkspace, env: OpenedEnv): Promise<string>;
  /** Measure the checkout again after something that moved many files. */
  refreshSize(workspace: StoredWorkspace): Promise<number>;
  touch(workspaceId: string, patch: { branch?: string; sizeBytes?: number }): Promise<void>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, type: string, message?: string): void {
  logErrorResponse(status, type, message);
  sendJson(response, status, { error: { type, message } });
}

/** Git's answer for the model: both streams, bounded; the caller scrubs. */
export function gitText(result: RunResult): string {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return clipOutput(text, GIT_OUTPUT_MAX_CHARS).text;
}

/** No editor ever: a message git would ask for is taken as given. */
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

/** The person a commit (or a reapplied commit) is authored as, from the request. */
export function authorEnv(body: Body): Record<string, string> {
  const author = isRecord(body.author) ? body.author : {};
  const name = str(author.name).trim() || 'Renkei';
  const email = str(author.email).trim() || 'renkei@localhost';
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export interface OperationState {
  inProgress: GitOperation | null;
  /** Paths with unresolved conflicts (`git diff --diff-filter=U`). */
  conflicts: string[];
}

/**
 * Whether git has an operation half-done in the checkout — the marker
 * directories and files git itself keeps under the (work)tree's git dir,
 * asked by `git rev-parse --git-path` so a worktree's own are found — and
 * which files are still in conflict.
 */
export async function operationState(input: RunInput): Promise<OperationState> {
  const markers: Array<[GitOperation, string]> = [
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
    ['merge', 'MERGE_HEAD'],
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
  ];
  const paths = await runGit(input, [
    'rev-parse',
    ...markers.flatMap(([, marker]) => ['--git-path', marker]),
  ]);
  let inProgress: GitOperation | null = null;
  if (paths.exitCode === 0) {
    const { stat } = await import('node:fs/promises');
    const resolved = paths.stdout.split('\n').filter(Boolean);
    for (let index = 0; index < markers.length && index < resolved.length; index += 1) {
      try {
        await stat(
          resolved[index]!.startsWith('/') ? resolved[index]! : `${input.cwd}/${resolved[index]!}`
        );
        inProgress = markers[index]![0];
        break;
      } catch {
        // Not that one.
      }
    }
  }
  const conflicted = await runGit(input, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = conflicted.exitCode === 0 ? conflicted.stdout.split('\n').filter(Boolean) : [];
  return { inProgress, conflicts };
}

export interface LogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  /** Decorations: branch and tag names at this commit. */
  refs: string[];
  parents: string[];
}

/** `git log` with the format below, one record a line group, into entries. */
export function parseLog(stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed.trim()) continue;
    const [sha, shortSha, subject, author, email, date, refs, parents] = trimmed.split('\0');
    if (!sha) continue;
    entries.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      subject: subject ?? '',
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      refs: (refs ?? '')
        .split(',')
        .map((ref) => ref.trim().replace(/^HEAD -> /, ''))
        .filter(Boolean),
      parents: (parents ?? '').split(' ').filter(Boolean),
    });
  }
  return entries;
}

const LOG_FORMAT = '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%D%x00%P%x1e';

export function createGitVerbs(ctx: GitVerbContext): Record<string, WorkspaceVerb> {
  const failed = (response: ServerResponse, env: OpenedEnv, result: RunResult, fallback: string) =>
    sendError(response, 409, 'git_failed', scrubEnv(gitText(result), env) || fallback);

  /** The checkout's paths from a body's `paths`, validated; null when one is bad (the refusal sent). */
  function pathsOf(body: Body, response: ServerResponse, max = 200): string[] | null {
    const paths: string[] = [];
    if (!Array.isArray(body.paths)) return paths;
    for (const raw of body.paths.slice(0, max)) {
      const path = validateWorkspacePath(raw, { forWrite: true });
      if (!path.ok || !path.path) {
        sendError(response, 400, 'bad_path', path.ok ? 'Empty path.' : path.message);
        return null;
      }
      paths.push(path.path);
    }
    return paths;
  }

  async function answerState(
    workspace: StoredWorkspace,
    env: OpenedEnv,
    input: RunInput,
    result: RunResult,
    response: ServerResponse,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const state = await operationState(input);
    const branch = await ctx.currentBranch(workspace, env);
    await ctx.touch(workspace.id, { branch });
    if (result.exitCode !== 0 && !state.inProgress) {
      return failed(response, env, result, 'git failed');
    }
    sendJson(response, 200, {
      branch,
      completed: result.exitCode === 0 && state.inProgress === null,
      inProgress: state.inProgress,
      conflicts: state.conflicts.map((path) => scrubEnv(path, env)),
      output: scrubEnv(gitText(result), env),
      ...extra,
    });
  }

  /** `git add` of every file still marked in conflict; null when that went fine (or there were none). */
  async function stageResolved(input: RunInput): Promise<RunResult | null> {
    const { conflicts } = await operationState(input);
    if (conflicts.length === 0) return null;
    const added = await runGit(input, ['add', '--', ...conflicts]);
    return added.exitCode === 0 ? null : added;
  }

  // ─── History ──────────────────────────────────────────────────────────

  const gitLog: WorkspaceVerb = async (workspace, env, body, response) => {
    const range = validateGitRange(body.ref);
    if (!range.ok) return sendError(response, 400, 'bad_request', range.message);
    const grep = validateGitLogFilter(body.grep);
    if (!grep.ok) return sendError(response, 400, 'bad_request', grep.message);
    const author = validateGitLogFilter(body.author);
    if (!author.ok) return sendError(response, 400, 'bad_request', author.message);
    const paths = pathsOf(body, response);
    if (!paths) return;
    const max =
      typeof body.max === 'number' && Number.isFinite(body.max)
        ? Math.min(GIT_LOG_MAX_COUNT, Math.max(1, Math.floor(body.max)))
        : GIT_LOG_DEFAULT_COUNT;
    const skip =
      typeof body.skip === 'number' && Number.isFinite(body.skip)
        ? Math.max(0, Math.floor(body.skip))
        : 0;
    const args = ['log', '--no-color', LOG_FORMAT, '-n', String(max + 1)];
    if (skip) args.push('--skip', String(skip));
    if (grep.filter) args.push(`--grep=${grep.filter}`, '--regexp-ignore-case');
    if (author.filter) args.push(`--author=${author.filter}`);
    if (body.all === true) args.push('--all');
    else args.push(range.range);
    args.push('--', ...paths);
    const input = ctx.runInputFor(workspace, env, 60_000);
    const logged = await runGit(input, args);
    if (logged.exitCode !== 0) return failed(response, env, logged, 'git log failed');
    const entries = parseLog(logged.stdout);
    const branch = await ctx.currentBranch(workspace, env);
    await ctx.touch(workspace.id, { branch });
    sendJson(response, 200, {
      branch,
      commits: entries.slice(0, max).map((entry) => ({
        ...entry,
        subject: scrubEnv(entry.subject, env),
        author: scrubEnv(entry.author, env),
        email: scrubEnv(entry.email, env),
      })),
      truncated: entries.length > max,
    });
  };

  // ─── The remote ───────────────────────────────────────────────────────

  const gitFetch: WorkspaceVerb = async (workspace, env, body, response) => {
    const gitProxy = parseGitProxy(body.gitProxy);
    if (!gitProxy) return sendError(response, 400, 'bad_request');
    const args = ['fetch', '--no-tags'];
    if (body.prune === true) args.push('--prune');
    args.push('origin');
    if (str(body.branch)) {
      const ref = validateGitRef(body.branch);
      if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
      args.push(`+refs/heads/${ref.ref}:refs/remotes/origin/${ref.ref}`);
    }
    const input = ctx.runInputFor(workspace, env, 5 * 60_000, { gitProxy });
    const fetched = await runGit(input, args);
    if (fetched.exitCode !== 0) return failed(response, env, fetched, 'git fetch failed');
    const branch = await ctx.currentBranch(workspace, env);
    const sizeBytes = await ctx.refreshSize(workspace);
    await ctx.touch(workspace.id, { branch, sizeBytes });
    sendJson(response, 200, {
      branch,
      output: scrubEnv(gitText(fetched), env) || 'Already up to date.',
    });
  };

  // ─── Branches ─────────────────────────────────────────────────────────

  const gitBranch: WorkspaceVerb = async (workspace, env, body, response) => {
    const action = str(body.action) || 'list';
    const input = ctx.runInputFor(workspace, env, 60_000);
    if (action === 'list') {
      const local = await runGit(input, [
        'branch',
        '--no-color',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00%(subject)',
      ]);
      if (local.exitCode !== 0) return failed(response, env, local, 'git branch failed');
      const remote = await runGit(input, [
        'branch',
        '-r',
        '--no-color',
        '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(subject)',
      ]);
      const branch = await ctx.currentBranch(workspace, env);
      await ctx.touch(workspace.id, { branch });
      return sendJson(response, 200, {
        branch,
        local: local.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [name, head, upstream, sha, subject] = line.split('\0');
            return {
              name: name ?? '',
              current: head === '*',
              upstream: upstream || null,
              sha: sha ?? '',
              subject: scrubEnv(subject ?? '', env),
            };
          }),
        remote: remote.stdout
          .split('\n')
          // origin/HEAD is a pointer at the default branch, not a branch.
          .filter((line) => line && !line.split('\0')[0]?.endsWith('/HEAD'))
          .map((line) => {
            const [, name, sha, subject] = line.split('\0');
            return { name: name ?? '', sha: sha ?? '', subject: scrubEnv(subject ?? '', env) };
          }),
      });
    }
    const ref = validateGitRef(body.name);
    if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
    let result: RunResult;
    if (action === 'create' || action === 'switch') {
      let start = '';
      if (str(body.start)) {
        const revision = validateGitRevision(body.start);
        if (!revision.ok) return sendError(response, 400, 'bad_request', revision.message);
        start = revision.revision;
      }
      if (action === 'create') {
        result = await runGit(input, ['branch', '--', ref.ref, ...(start ? [start] : [])]);
      } else if (body.create === true) {
        result = await runGit(input, [
          'switch',
          '--no-track',
          '-c',
          ref.ref,
          ...(start ? [start] : []),
        ]);
      } else {
        // A local branch, or — when only the remote has it — a tracking
        // branch made from it, as `git switch` does itself.
        result = await runGit(input, ['switch', ref.ref]);
      }
    } else if (action === 'delete') {
      result = await runGit(input, ['branch', body.force === true ? '-D' : '-d', '--', ref.ref]);
    } else {
      return sendError(response, 400, 'bad_request', 'action is list, create, switch or delete.');
    }
    if (result.exitCode !== 0) return failed(response, env, result, `git branch ${action} failed`);
    const branch = await ctx.currentBranch(workspace, env);
    const sizeBytes = action === 'switch' ? await ctx.refreshSize(workspace) : undefined;
    await ctx.touch(workspace.id, { branch, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
    sendJson(response, 200, { branch, output: scrubEnv(gitText(result), env) });
  };

  // ─── Rebase and merge ─────────────────────────────────────────────────

  const gitRebase: WorkspaceVerb = async (workspace, env, body, response) => {
    const action = str(body.action) || 'start';
    const input = ctx.runInputFor(workspace, env, 5 * 60_000, {
      extraEnv: { ...authorEnv(body), ...NO_EDITOR },
    });
    let result: RunResult;
    switch (action) {
      case 'start': {
        const onto = validateGitRevision(body.onto);
        if (!onto.ok) return sendError(response, 400, 'bad_request', onto.message);
        const before = await operationState(input);
        if (before.inProgress) {
          return sendError(
            response,
            409,
            'git_in_progress',
            `A ${before.inProgress} is already in progress; continue, skip or abort it first.`
          );
        }
        const args = ['rebase'];
        if (body.autostash === true) args.push('--autostash');
        args.push(onto.revision);
        result = await runGit(input, args);
        break;
      }
      case 'continue': {
        // The resolved files are staged here: the caller edits them with the
        // file tools and has no `git add` of its own.
        const staged = await stageResolved(input);
        if (staged) return failed(response, env, staged, 'git add failed');
        result = await runGit(input, ['rebase', '--continue']);
        break;
      }
      case 'skip':
      case 'abort':
        result = await runGit(input, ['rebase', `--${action}`]);
        break;
      default:
        return sendError(response, 400, 'bad_request', 'action is start, continue, skip or abort.');
    }
    await answerState(workspace, env, input, result, response);
  };

  const gitMerge: WorkspaceVerb = async (workspace, env, body, response) => {
    const action = str(body.action) || 'start';
    const input = ctx.runInputFor(workspace, env, 5 * 60_000, {
      extraEnv: { ...authorEnv(body), ...NO_EDITOR },
    });
    let result: RunResult;
    switch (action) {
      case 'start': {
        const ref = validateGitRevision(body.ref);
        if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
        const before = await operationState(input);
        if (before.inProgress) {
          return sendError(
            response,
            409,
            'git_in_progress',
            `A ${before.inProgress} is already in progress; continue or abort it first.`
          );
        }
        const args = ['merge', '--no-edit'];
        if (body.noFastForward === true) args.push('--no-ff');
        if (body.squash === true) args.push('--squash');
        const message = str(body.message).trim();
        if (message) args.push('-m', message.slice(0, 4_000));
        args.push(ref.revision);
        result = await runGit(input, args);
        break;
      }
      case 'continue': {
        const staged = await stageResolved(input);
        if (staged) return failed(response, env, staged, 'git add failed');
        result = await runGit(input, ['merge', '--continue']);
        break;
      }
      case 'abort':
        result = await runGit(input, ['merge', '--abort']);
        break;
      default:
        return sendError(response, 400, 'bad_request', 'action is start, continue or abort.');
    }
    await answerState(workspace, env, input, result, response);
  };

  // ─── Undoing ──────────────────────────────────────────────────────────

  const gitReset: WorkspaceVerb = async (workspace, env, body, response) => {
    const mode = str(body.mode) || 'mixed';
    if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) {
      return sendError(response, 400, 'bad_request', 'mode is soft, mixed, hard or keep.');
    }
    let target = 'HEAD';
    if (str(body.target)) {
      const revision = validateGitRevision(body.target);
      if (!revision.ok) return sendError(response, 400, 'bad_request', revision.message);
      target = revision.revision;
    }
    const paths = pathsOf(body, response);
    if (!paths) return;
    const input = ctx.runInputFor(workspace, env, 120_000);
    const result = paths.length
      ? // Paths: the index only (unstage), whatever the mode said.
        await runGit(input, ['reset', target, '--', ...paths])
      : await runGit(input, ['reset', `--${mode}`, target]);
    if (result.exitCode !== 0) return failed(response, env, result, 'git reset failed');
    const head = await runGit(input, ['log', '-1', '--format=%h %s']);
    const branch = await ctx.currentBranch(workspace, env);
    const sizeBytes = mode === 'hard' ? await ctx.refreshSize(workspace) : undefined;
    await ctx.touch(workspace.id, { branch, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
    sendJson(response, 200, {
      branch,
      head: scrubEnv(head.stdout.trim(), env),
      output: scrubEnv(gitText(result), env),
    });
  };

  const gitStash: WorkspaceVerb = async (workspace, env, body, response) => {
    const action = str(body.action) || 'list';
    const input = ctx.runInputFor(workspace, env, 120_000, { extraEnv: authorEnv(body) });
    const listStashes = async () => {
      const listed = await runGit(input, ['stash', 'list', '--format=%gd%x00%gs%x00%ci']);
      return listed.stdout
        .split('\n')
        .filter(Boolean)
        .map((line, index) => {
          const [ref, message, date] = line.split('\0');
          return {
            index,
            ref: ref ?? `stash@{${index}}`,
            message: scrubEnv(message ?? '', env),
            date: date ?? '',
          };
        });
    };
    let result: RunResult | null = null;
    switch (action) {
      case 'list':
        break;
      case 'push': {
        const message = validateStashMessage(body.message);
        if (!message.ok) return sendError(response, 400, 'bad_request', message.message);
        const paths = pathsOf(body, response);
        if (!paths) return;
        const args = ['stash', 'push'];
        if (body.includeUntracked === true) args.push('--include-untracked');
        if (message.message) args.push('-m', message.message);
        if (paths.length) args.push('--', ...paths);
        result = await runGit(input, args);
        break;
      }
      case 'pop':
      case 'apply':
      case 'drop':
      case 'show': {
        const index = validateStashIndex(body.index);
        if (!index.ok) return sendError(response, 400, 'bad_request', index.message);
        const name = `stash@{${index.index}}`;
        result =
          action === 'show'
            ? await runGit(input, ['stash', 'show', '--no-color', '--stat', '-p', name])
            : await runGit(input, ['stash', action, name]);
        break;
      }
      default:
        return sendError(
          response,
          400,
          'bad_request',
          'action is list, push, pop, apply, drop or show.'
        );
    }
    if (result && result.exitCode !== 0) {
      // A pop or apply that conflicted leaves the stash and the conflict in place; say which files.
      const state = await operationState(input);
      if (state.conflicts.length === 0)
        return failed(response, env, result, `git stash ${action} failed`);
    }
    const stashes = await listStashes();
    const branch = await ctx.currentBranch(workspace, env);
    const sizeBytes =
      action === 'list' || action === 'show' ? undefined : await ctx.refreshSize(workspace);
    await ctx.touch(workspace.id, { branch, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
    const text = result ? gitText(result) : '';
    sendJson(response, 200, {
      branch,
      stashes,
      output: scrubEnv(text.length > DIFF_MAX_CHARS ? text.slice(0, DIFF_MAX_CHARS) : text, env),
      conflicts:
        result && result.exitCode !== 0
          ? (await operationState(input)).conflicts.map((path) => scrubEnv(path, env))
          : [],
    });
  };

  const gitClean: WorkspaceVerb = async (workspace, env, body, response) => {
    const paths = pathsOf(body, response);
    if (!paths) return;
    // Dry by default: nothing is removed unless the caller said dryRun: false.
    const dryRun = body.dryRun !== false;
    const args = ['clean', '-d', dryRun ? '-n' : '-f'];
    if (body.ignored === true) args.push('-x');
    if (paths.length) args.push('--', ...paths);
    const input = ctx.runInputFor(workspace, env, 120_000);
    const cleaned = await runGit(input, args);
    if (cleaned.exitCode !== 0) return failed(response, env, cleaned, 'git clean failed');
    const branch = await ctx.currentBranch(workspace, env);
    const sizeBytes = dryRun ? undefined : await ctx.refreshSize(workspace);
    await ctx.touch(workspace.id, { branch, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
    sendJson(response, 200, {
      branch,
      dryRun,
      paths: parseCleanOutput(cleaned.stdout).map((path) => scrubEnv(path, env)),
    });
  };

  // ─── Sparse checkout ──────────────────────────────────────────────────

  const gitSparseCheckout: WorkspaceVerb = async (workspace, env, body, response) => {
    const action = str(body.action) || 'list';
    const input = ctx.runInputFor(workspace, env, 5 * 60_000);
    let result: RunResult | null = null;
    switch (action) {
      case 'list':
        break;
      case 'set':
      case 'add': {
        const paths = validateSparsePaths(body.paths);
        if (!paths.ok) return sendError(response, 400, 'bad_request', paths.message);
        // `set` chooses the mode; `add` keeps whatever mode is on.
        result = await runGit(input, [
          'sparse-checkout',
          action,
          ...(action === 'set' ? [body.cone === false ? '--no-cone' : '--cone'] : []),
          '--',
          ...paths.paths,
        ]);
        break;
      }
      case 'disable':
        result = await runGit(input, ['sparse-checkout', 'disable']);
        break;
      default:
        return sendError(response, 400, 'bad_request', 'action is list, set, add or disable.');
    }
    if (result && result.exitCode !== 0) {
      return failed(response, env, result, `git sparse-checkout ${action} failed`);
    }
    const enabled =
      (await runGit(input, ['config', '--get', 'core.sparseCheckout'])).stdout.trim() === 'true';
    const listed = enabled ? await runGit(input, ['sparse-checkout', 'list']) : null;
    const branch = await ctx.currentBranch(workspace, env);
    const sizeBytes = action === 'list' ? undefined : await ctx.refreshSize(workspace);
    await ctx.touch(workspace.id, { branch, ...(sizeBytes !== undefined ? { sizeBytes } : {}) });
    sendJson(response, 200, {
      branch,
      enabled,
      patterns: listed?.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean) : [],
      output: result ? scrubEnv(gitText(result), env) : '',
    });
  };

  return {
    'git-log': gitLog,
    'git-fetch': gitFetch,
    'git-branch': gitBranch,
    'git-rebase': gitRebase,
    'git-merge': gitMerge,
    'git-reset': gitReset,
    'git-stash': gitStash,
    'git-clean': gitClean,
    'git-sparse-checkout': gitSparseCheckout,
  };
}
