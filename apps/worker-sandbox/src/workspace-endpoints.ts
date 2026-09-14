/**
 * The HTTP verbs for code workspaces and their environment secrets —
 * dispatched from server.ts under `/v1/workspaces/*` and `/v1/env/*`,
 * the same bearer-keyed, (tenantId, subject)-scoped JSON POST shape as
 * every other sandbox operation.
 *
 * Three rules every workspace verb keeps:
 *
 *  - The row first. A workspace is looked up by id UNDER the caller's
 *    (tenantId, subject) before anything touches disk; a workspace that
 *    is not theirs does not exist. Use extends its lifetime.
 *  - Text out is scrubbed. The caller's environment secrets are opened
 *    once per request and every string in the answer — output, file
 *    text, grep lines, git's own messages — goes through `scrubEnv`, so
 *    no verb can be the channel that reveals a value.
 *  - A credential rides one request. A clone or a push takes the git
 *    Authorization header in its body, hands it to that one child
 *    process's environment, and keeps nothing.
 *
 * The clone runs in the background: the verb answers with the row in
 * `cloning` and the caller polls `list`/`get`, because a real repository
 * takes longer than any one tool call should wait.
 */

import type { ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  CLONE_DEFAULT_DEPTH,
  COMMIT_MESSAGE_MAX_CHARS,
  DIFF_DEFAULT_CONTEXT,
  DIFF_MAX_CHARS,
  DIFF_MAX_CONTEXT,
  DIFF_MAX_UNTRACKED,
  ENV_MAX_PER_SUBJECT,
  FIND_MAX_RESULTS,
  GIT_OUTPUT_MAX_CHARS,
  GREP_MAX_MATCHES,
  READ_MAX_BYTES,
  WORKSPACE_MAX_BYTES,
  WORKSPACE_MAX_PER_SUBJECT,
  UPLOAD_MAX_BYTES,
  WRITE_MAX_CHARS,
  clipOutput,
  execTimeoutMs,
  isWorkspaceProvider,
  looksBinary,
  validateCommand,
  validateEnvName,
  validateEnvValue,
  validateGitRef,
  validateGlob,
  validateGrepPattern,
  validateRepoFullName,
  validateWorkspacePath,
  type SandboxWorkspaceSummary,
} from '@renkei/connector-sandbox';
import * as store from './workspace-store';
import * as envStore from './env-secrets-store';
import {
  EMPTY_ENV,
  envSecretsEnabled,
  envSecretsKey,
  markEnvUsed,
  openCallerEnv,
  scrubEnv,
  sealEnvValue,
  type OpenedEnv,
} from './env-secrets';
import {
  WorkspacePathError,
  cloneRepository,
  containedPath,
  findFiles,
  grepFiles,
  homeDir,
  identityFor,
  listDirectory,
  measureWorkspace,
  newWorkspaceStorageKey,
  readWorkspaceFile,
  removeWorkspace,
  runGit,
  runShell,
  workspaceDir,
  writeWorkspaceFile,
  type RunInput,
  type RunResult,
} from './workspaces';
import { logger } from './logger';

export interface WorkspaceHandlerDeps {
  db: Kysely<DB>;
  /** Whether workspaces are enabled on this worker at all (SANDBOX_WORKSPACES_ENABLED). */
  enabled: boolean;
}

type Body = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  sendJson(response, status, { error: { type, message } });
}

export function workspaceWire(summary: SandboxWorkspaceSummary) {
  return {
    id: summary.id,
    provider: summary.provider,
    repoFullName: summary.repoFullName,
    branch: summary.branch,
    status: summary.status,
    error: summary.error,
    sizeBytes: summary.sizeBytes,
    createdAt: summary.createdAt.toISOString(),
    lastUsedAt: summary.lastUsedAt.toISOString(),
    expiresAt: summary.expiresAt.toISOString(),
  };
}

function envWire(summary: envStore.EnvSecretSummary) {
  return {
    id: summary.id,
    name: summary.name,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    lastUsedAt: summary.lastUsedAt ? summary.lastUsedAt.toISOString() : null,
  };
}

function targetOf(body: Body): store.WorkspaceTarget | null {
  const tenantId = str(body.tenantId);
  const subject = str(body.subject);
  if (!tenantId || !subject) return null;
  return { tenantId, subject };
}

/** Git's answer for the model: both streams, bounded, scrubbed by the caller. */
function gitText(result: RunResult): string {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return clipOutput(text, GIT_OUTPUT_MAX_CHARS).text;
}

export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { db } = deps;

  /** The caller's workspace, ready to work in, or the refusal already sent. */
  async function loadReady(
    target: store.WorkspaceTarget,
    body: Body,
    response: ServerResponse
  ): Promise<store.StoredWorkspace | null> {
    const id = str(body.id);
    const workspace = id ? await store.getWorkspace(db, target, id) : undefined;
    if (!workspace) {
      sendError(response, 404, 'not_found', 'No such workspace — see the list.');
      return null;
    }
    if (workspace.status === 'cloning') {
      sendError(
        response,
        409,
        'not_ready',
        'That workspace is still cloning; check again shortly.'
      );
      return null;
    }
    if (workspace.status === 'failed') {
      sendError(
        response,
        409,
        'not_ready',
        `That workspace's clone failed (${workspace.error ?? 'unknown reason'}); delete it and clone again.`
      );
      return null;
    }
    return workspace;
  }

  function runInputFor(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    timeoutMs: number,
    extra: Partial<RunInput> = {}
  ): RunInput {
    return {
      cwd: workspaceDir(workspace.storageKey),
      home: homeDir(workspace.storageKey),
      identity: identityFor(workspace),
      env: env.values,
      timeoutMs,
      ...extra,
    };
  }

  async function refreshSize(workspace: store.StoredWorkspace): Promise<number> {
    const sizeBytes = await measureWorkspace(workspaceDir(workspace.storageKey));
    await store.touchWorkspace(db, workspace.id, { sizeBytes });
    return sizeBytes;
  }

  async function currentBranch(workspace: store.StoredWorkspace, env: OpenedEnv): Promise<string> {
    const head = await runGit(runInputFor(workspace, env, 30_000), [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    return head.exitCode === 0 ? head.stdout.trim() : workspace.branch;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async function clone(
    target: store.WorkspaceTarget,
    body: Body,
    response: ServerResponse
  ): Promise<void> {
    if (!isWorkspaceProvider(body.provider)) {
      return sendError(response, 400, 'bad_request', 'Unknown repository provider.');
    }
    const repo = validateRepoFullName(body.repoFullName);
    if (!repo.ok) return sendError(response, 400, 'bad_request', repo.message);
    let branch = '';
    if (str(body.branch)) {
      const ref = validateGitRef(body.branch);
      if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
      branch = ref.ref;
    }
    const cloneUrl = str(body.cloneUrl);
    const authHeader = str(body.authHeader);
    if (!/^https:\/\/bitbucket\.org\/[^\s]+\.git$/.test(cloneUrl) || !authHeader) {
      return sendError(response, 400, 'bad_request');
    }
    const depth =
      typeof body.depth === 'number' && Number.isFinite(body.depth)
        ? Math.max(0, Math.floor(body.depth))
        : CLONE_DEFAULT_DEPTH;

    if ((await store.countWorkspaces(db, target)) >= WORKSPACE_MAX_PER_SUBJECT) {
      return sendError(
        response,
        429,
        'workspace_limit',
        `At most ${WORKSPACE_MAX_PER_SUBJECT} workspaces at once — delete one first.`
      );
    }

    const storageKey = newWorkspaceStorageKey(target.tenantId, target.subject);
    const row = await store.insertWorkspace(db, {
      ...target,
      provider: body.provider,
      repoFullName: repo.fullName,
      branch: branch || '(default)',
      storageKey,
    });

    // The clone outlives this request. Whatever happens, the row ends up
    // ready or failed — a crash mid-clone leaves `cloning`, which the
    // sweep retires once the row's lifetime lapses.
    void (async () => {
      const outcome = await cloneRepository({
        storageKey,
        identity: identityFor(target),
        cloneUrl,
        authHeader,
        branch,
        depth,
      });
      if (!outcome.ok) {
        logger.warn('workspace clone failed for {repo}: {error}', {
          component: 'worker-sandbox/workspaces',
          repo: repo.fullName,
          error: outcome.message,
        });
        await store.setWorkspaceStatus(db, row.id, 'failed', { error: outcome.message });
        return;
      }
      const sizeBytes = await measureWorkspace(workspaceDir(storageKey));
      await store.setWorkspaceStatus(db, row.id, 'ready', { sizeBytes, branch: outcome.branch });
      logger.info('workspace cloned {repo} ({bytes} bytes)', {
        component: 'worker-sandbox/workspaces',
        repo: repo.fullName,
        bytes: sizeBytes,
      });
    })().catch((error: unknown) => {
      logger.error('workspace clone crashed: {error}', {
        component: 'worker-sandbox/workspaces',
        error: error instanceof Error ? error.message : String(error),
      });
      void store.setWorkspaceStatus(db, row.id, 'failed', {
        error: 'The clone failed unexpectedly.',
      });
    });

    sendJson(response, 200, { workspace: workspaceWire(row) });
  }

  async function list(target: store.WorkspaceTarget, response: ServerResponse): Promise<void> {
    const rows = await store.listWorkspaces(db, target);
    sendJson(response, 200, { workspaces: rows.map(workspaceWire) });
  }

  async function get(
    target: store.WorkspaceTarget,
    body: Body,
    response: ServerResponse
  ): Promise<void> {
    const id = str(body.id);
    const workspace = id ? await store.getWorkspace(db, target, id) : undefined;
    if (!workspace) return sendError(response, 404, 'not_found');
    sendJson(response, 200, { workspace: workspaceWire(workspace) });
  }

  async function remove(
    target: store.WorkspaceTarget,
    body: Body,
    response: ServerResponse
  ): Promise<void> {
    const id = str(body.id);
    const deleted = id ? await store.deleteWorkspace(db, target, id) : undefined;
    if (!deleted) return sendError(response, 404, 'not_found');
    await removeWorkspace(deleted.storageKey);
    sendJson(response, 200, { deleted: true, id: deleted.id, repoFullName: deleted.repoFullName });
  }

  // ─── Files ────────────────────────────────────────────────────────────

  async function ls(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const path = validateWorkspacePath(body.path);
    if (!path.ok) return sendError(response, 400, 'bad_path', path.message);
    const listed = await listDirectory(workspaceDir(workspace.storageKey), path.path);
    if ('error' in listed) return sendError(response, 404, 'not_found', listed.error);
    sendJson(response, 200, {
      path: path.path,
      entries: listed.map((entry) => ({ ...entry, path: scrubEnv(entry.path, env) })),
    });
  }

  async function find(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const glob = validateGlob(body.glob);
    if (!glob.ok) return sendError(response, 400, 'bad_request', glob.message);
    const max =
      typeof body.max === 'number'
        ? Math.min(FIND_MAX_RESULTS, Math.max(1, Math.floor(body.max)))
        : FIND_MAX_RESULTS;
    const found = await findFiles({
      dir: workspaceDir(workspace.storageKey),
      home: homeDir(workspace.storageKey),
      identity: identityFor(workspace),
      glob: glob.glob,
      max,
    });
    if ('error' in found)
      return sendError(response, 500, 'search_failed', scrubEnv(found.error, env));
    sendJson(response, 200, {
      paths: found.paths.map((path) => scrubEnv(path, env)),
      truncated: found.truncated,
    });
  }

  async function grep(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const pattern = validateGrepPattern(body.pattern);
    if (!pattern.ok) return sendError(response, 400, 'bad_request', pattern.message);
    const path = validateWorkspacePath(body.path);
    if (!path.ok) return sendError(response, 400, 'bad_path', path.message);
    const glob = validateGlob(body.glob);
    if (!glob.ok) return sendError(response, 400, 'bad_request', glob.message);
    const max =
      typeof body.max === 'number'
        ? Math.min(GREP_MAX_MATCHES, Math.max(1, Math.floor(body.max)))
        : GREP_MAX_MATCHES;
    const found = await grepFiles({
      dir: workspaceDir(workspace.storageKey),
      home: homeDir(workspace.storageKey),
      identity: identityFor(workspace),
      pattern: pattern.pattern,
      path: path.path,
      glob: glob.glob,
      caseInsensitive: body.caseInsensitive === true,
      fixedStrings: body.fixedStrings === true,
      max,
    });
    if ('error' in found)
      return sendError(response, 400, 'search_failed', scrubEnv(found.error, env));
    sendJson(response, 200, {
      matches: found.matches.map((match) => ({
        path: scrubEnv(match.path, env),
        line: match.line,
        text: scrubEnv(match.text, env),
      })),
      truncated: found.truncated,
    });
  }

  async function read(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const path = validateWorkspacePath(body.path);
    if (!path.ok) return sendError(response, 400, 'bad_path', path.message);
    const outcome = await readWorkspaceFile(
      workspaceDir(workspace.storageKey),
      path.path,
      READ_MAX_BYTES
    );
    if ('error' in outcome) return sendError(response, 404, 'not_found', outcome.error);
    if (looksBinary(outcome.bytes)) {
      return sendError(response, 415, 'binary_file', `${path.path} is a binary file.`);
    }
    const lines = outcome.bytes.toString('utf8').split('\n');
    const totalLines = lines.length;
    const startLine =
      typeof body.startLine === 'number' && body.startLine >= 1 ? Math.floor(body.startLine) : 1;
    const maxLines =
      typeof body.maxLines === 'number' && body.maxLines >= 1
        ? Math.floor(body.maxLines)
        : totalLines;
    const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
    sendJson(response, 200, {
      path: path.path,
      text: scrubEnv(slice.join('\n'), env),
      sizeBytes: outcome.sizeBytes,
      totalLines,
      startLine,
      endLine: startLine - 1 + slice.length,
    });
  }

  async function write(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const path = validateWorkspacePath(body.path, { forWrite: true });
    if (!path.ok || !path.path)
      return sendError(
        response,
        400,
        'bad_path',
        path.ok ? 'A file path is required.' : path.message
      );
    const content = str(body.content);
    if (typeof body.content !== 'string')
      return sendError(response, 400, 'bad_request', 'content must be a string.');
    if (content.length > WRITE_MAX_CHARS) {
      return sendError(
        response,
        413,
        'too_large',
        `A write is at most ${WRITE_MAX_CHARS} characters.`
      );
    }
    if (workspace.sizeBytes > WORKSPACE_MAX_BYTES) {
      return sendError(
        response,
        413,
        'quota_exceeded',
        'The workspace is over its size limit; remove some files first.'
      );
    }
    const written = await writeWorkspaceFile(
      workspaceDir(workspace.storageKey),
      path.path,
      content,
      identityFor(workspace)
    );
    await store.touchWorkspace(db, workspace.id);
    sendJson(response, 200, {
      path: path.path,
      created: written.created,
      sizeBytes: written.sizeBytes,
    });
  }

  async function edit(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const path = validateWorkspacePath(body.path, { forWrite: true });
    if (!path.ok || !path.path)
      return sendError(
        response,
        400,
        'bad_path',
        path.ok ? 'A file path is required.' : path.message
      );
    const oldText = str(body.oldText);
    const newText = str(body.newText);
    if (!oldText) return sendError(response, 400, 'bad_request', 'oldText must be non-empty.');
    if (typeof body.newText !== 'string')
      return sendError(response, 400, 'bad_request', 'newText must be a string.');
    if (oldText === newText)
      return sendError(response, 400, 'bad_request', 'oldText and newText are identical.');
    const dir = workspaceDir(workspace.storageKey);
    const outcome = await readWorkspaceFile(dir, path.path, READ_MAX_BYTES);
    if ('error' in outcome) return sendError(response, 404, 'not_found', outcome.error);
    if (looksBinary(outcome.bytes))
      return sendError(response, 415, 'binary_file', `${path.path} is a binary file.`);
    const current = outcome.bytes.toString('utf8');
    const occurrences = current.split(oldText).length - 1;
    if (occurrences === 0) {
      return sendError(response, 409, 'edit_conflict', `oldText was not found in ${path.path}.`);
    }
    if (occurrences > 1 && body.replaceAll !== true) {
      return sendError(
        response,
        409,
        'edit_conflict',
        `oldText occurs ${occurrences} times in ${path.path}; include more context so it is unique, or pass replaceAll.`
      );
    }
    const updated =
      body.replaceAll === true
        ? current.split(oldText).join(newText)
        : current.replace(oldText, () => newText);
    if (updated.length > WRITE_MAX_CHARS) {
      return sendError(
        response,
        413,
        'too_large',
        `The edited file would exceed ${WRITE_MAX_CHARS} characters.`
      );
    }
    await writeWorkspaceFile(dir, path.path, updated, identityFor(workspace));
    await store.touchWorkspace(db, workspace.id);
    sendJson(response, 200, {
      path: path.path,
      replacements: body.replaceAll === true ? occurrences : 1,
    });
  }

  // ─── Commands ─────────────────────────────────────────────────────────

  async function exec(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const command = validateCommand(body.command);
    if (!command.ok) return sendError(response, 400, 'bad_request', command.message);
    if (workspace.sizeBytes > WORKSPACE_MAX_BYTES) {
      return sendError(
        response,
        413,
        'quota_exceeded',
        `The workspace is over its ${WORKSPACE_MAX_BYTES}-byte limit; remove build output or delete the workspace.`
      );
    }
    const timeoutMs = execTimeoutMs(body.timeoutMs);
    const result = await runShell(runInputFor(workspace, env, timeoutMs), command.command);
    await markEnvUsed(db, env);
    const sizeBytes = await refreshSize(workspace);
    sendJson(response, 200, {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: scrubEnv(result.stdout, env),
      stderr: scrubEnv(result.stderr, env),
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      timeoutMs,
      sizeBytes,
      unreadableEnv: env.unreadable,
    });
  }

  // ─── Git ──────────────────────────────────────────────────────────────

  async function gitStatus(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const input = runInputFor(workspace, env, 60_000);
    const branch = await currentBranch(workspace, env);
    const status = await runGit(input, ['status', '--porcelain=v1', '--branch']);
    const parts: Record<string, unknown> = {
      branch,
      status: scrubEnv(gitText(status), env),
    };
    if (body.diff === true) {
      const diff = await runGit(input, ['diff', 'HEAD', '--', '.']);
      parts.diff = scrubEnv(gitText(diff), env);
    } else {
      const stat = await runGit(input, ['diff', 'HEAD', '--stat', '--', '.']);
      parts.diffStat = scrubEnv(gitText(stat), env);
    }
    const logCount =
      typeof body.log === 'number' ? Math.min(50, Math.max(0, Math.floor(body.log))) : 0;
    if (logCount > 0) {
      const log = await runGit(input, [
        'log',
        '--oneline',
        '--no-decorate',
        `-n`,
        String(logCount),
      ]);
      parts.log = scrubEnv(gitText(log), env);
    }
    await store.touchWorkspace(db, workspace.id, { branch });
    sendJson(response, 200, parts);
  }

  /**
   * The working tree against HEAD as one unified diff — tracked changes
   * from git itself, untracked files each diffed against nothing so a
   * new file shows as all additions — with per-file added/deleted line
   * counts. `context` is the lines around each hunk (a page can ask for
   * more than the model would); `paths` narrows it to some files. The
   * text is bounded; when cut, `truncated` says so and the counts still
   * cover everything. `statOnly` skips the text and answers the counts.
   */
  async function gitDiff(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const context =
      typeof body.context === 'number' && Number.isFinite(body.context)
        ? Math.min(DIFF_MAX_CONTEXT, Math.max(0, Math.floor(body.context)))
        : DIFF_DEFAULT_CONTEXT;
    const paths: string[] = [];
    if (Array.isArray(body.paths)) {
      for (const raw of body.paths.slice(0, 200)) {
        const path = validateWorkspacePath(raw);
        if (!path.ok) return sendError(response, 400, 'bad_path', path.message);
        if (path.path) paths.push(path.path);
      }
    }
    const statOnly = body.statOnly === true;
    const input = runInputFor(workspace, env, 60_000);
    const branch = await currentBranch(workspace, env);
    const scope = paths.length ? paths : ['.'];
    const tracked = statOnly
      ? null
      : await runGit(input, ['diff', `-U${context}`, 'HEAD', '--', ...scope]);
    const numstat = await runGit(input, ['diff', '--numstat', 'HEAD', '--', ...scope]);
    const untrackedList = await runGit(input, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      ...scope,
    ]);
    const files: { path: string; added: number; deleted: number; status: string }[] = [];
    for (const line of numstat.stdout.split('\n')) {
      const [added, deleted, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!path) continue;
      files.push({
        path,
        added: added === '-' ? 0 : Number(added) || 0,
        deleted: deleted === '-' ? 0 : Number(deleted) || 0,
        status: 'modified',
      });
    }
    const pieces = [tracked?.stdout ?? ''];
    const untracked = untrackedList.stdout.split('\n').filter(Boolean);
    for (const path of untracked.slice(0, DIFF_MAX_UNTRACKED)) {
      const one = statOnly
        ? null
        : await runGit(input, ['diff', '--no-index', `-U${context}`, '--', '/dev/null', path]);
      const stat = await runGit(input, [
        'diff',
        '--no-index',
        '--numstat',
        '--',
        '/dev/null',
        path,
      ]);
      const [added] = stat.stdout.split('\t');
      files.push({
        path,
        added: added === '-' || added === undefined ? 0 : Number(added) || 0,
        deleted: 0,
        status: 'untracked',
      });
      if (one) pieces.push(one.stdout);
    }
    for (const path of untracked.slice(DIFF_MAX_UNTRACKED)) {
      files.push({ path, added: 0, deleted: 0, status: 'untracked' });
    }
    const joined = pieces.filter(Boolean).join('');
    const truncated = joined.length > DIFF_MAX_CHARS;
    await store.touchWorkspace(db, workspace.id, { branch });
    sendJson(response, 200, {
      branch,
      diff: scrubEnv(truncated ? joined.slice(0, DIFF_MAX_CHARS) : joined, env),
      files: files.map((file) => ({ ...file, path: scrubEnv(file.path, env) })),
      truncated,
    });
  }

  async function gitCommit(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const message = str(body.message).trim();
    if (!message) return sendError(response, 400, 'bad_request', 'A commit message is required.');
    if (message.length > COMMIT_MESSAGE_MAX_CHARS) {
      return sendError(
        response,
        400,
        'bad_request',
        `A commit message is at most ${COMMIT_MESSAGE_MAX_CHARS} characters.`
      );
    }
    const author = isRecord(body.author) ? body.author : {};
    const name = str(author.name).trim() || 'Renkei';
    const email = str(author.email).trim() || 'renkei@localhost';
    const input = runInputFor(workspace, env, 120_000, {
      extraEnv: {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    });
    if (str(body.newBranch)) {
      const ref = validateGitRef(body.newBranch);
      if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
      const switched = await runGit(input, ['checkout', '-b', ref.ref]);
      if (switched.exitCode !== 0) {
        return sendError(response, 409, 'git_failed', scrubEnv(gitText(switched), env));
      }
    }
    const paths: string[] = [];
    if (Array.isArray(body.paths)) {
      for (const raw of body.paths) {
        const path = validateWorkspacePath(raw, { forWrite: true });
        if (!path.ok || !path.path)
          return sendError(response, 400, 'bad_path', path.ok ? 'Empty path.' : path.message);
        paths.push(path.path);
      }
    }
    const added = await runGit(input, paths.length ? ['add', '--', ...paths] : ['add', '--all']);
    if (added.exitCode !== 0)
      return sendError(response, 409, 'git_failed', scrubEnv(gitText(added), env));
    const committed = await runGit(input, ['commit', '--quiet', '--no-verify', '-m', message]);
    if (committed.exitCode !== 0) {
      return sendError(
        response,
        409,
        'git_failed',
        scrubEnv(gitText(committed), env) || 'Nothing to commit.'
      );
    }
    const head = await runGit(input, ['log', '-1', '--format=%h %s']);
    const branch = await currentBranch(workspace, env);
    await store.touchWorkspace(db, workspace.id, { branch });
    sendJson(response, 200, { branch, commit: scrubEnv(head.stdout.trim(), env) });
  }

  async function gitPush(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const authHeader = str(body.authHeader);
    if (!authHeader) return sendError(response, 400, 'bad_request');
    const branch = await currentBranch(workspace, env);
    if (branch === 'HEAD') {
      return sendError(
        response,
        409,
        'git_failed',
        'The workspace is not on a branch (detached HEAD); commit onto a branch first.'
      );
    }
    let remoteBranch = branch;
    if (str(body.branch)) {
      const ref = validateGitRef(body.branch);
      if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
      remoteBranch = ref.ref;
    }
    const input = runInputFor(workspace, env, 5 * 60_000, { gitAuthHeader: authHeader });
    const pushed = await runGit(input, [
      'push',
      '--set-upstream',
      'origin',
      `HEAD:refs/heads/${remoteBranch}`,
    ]);
    if (pushed.exitCode !== 0)
      return sendError(response, 409, 'git_failed', scrubEnv(gitText(pushed), env));
    await store.touchWorkspace(db, workspace.id, { branch });
    sendJson(response, 200, { branch, remoteBranch, output: scrubEnv(gitText(pushed), env) });
  }

  async function gitPull(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const authHeader = str(body.authHeader);
    if (!authHeader) return sendError(response, 400, 'bad_request');
    const input = runInputFor(workspace, env, 5 * 60_000, { gitAuthHeader: authHeader });
    let output: string;
    if (str(body.branch)) {
      const ref = validateGitRef(body.branch);
      if (!ref.ok) return sendError(response, 400, 'bad_request', ref.message);
      const fetched = await runGit(input, [
        'fetch',
        '--no-tags',
        'origin',
        `+refs/heads/${ref.ref}:refs/remotes/origin/${ref.ref}`,
      ]);
      if (fetched.exitCode !== 0)
        return sendError(response, 409, 'git_failed', scrubEnv(gitText(fetched), env));
      const switched = await runGit(input, [
        'checkout',
        '--track',
        '-B',
        ref.ref,
        `origin/${ref.ref}`,
      ]);
      if (switched.exitCode !== 0)
        return sendError(response, 409, 'git_failed', scrubEnv(gitText(switched), env));
      output = gitText(switched);
    } else {
      const pulled = await runGit(input, ['pull', '--no-tags', '--ff-only', 'origin']);
      if (pulled.exitCode !== 0)
        return sendError(response, 409, 'git_failed', scrubEnv(gitText(pulled), env));
      output = gitText(pulled);
    }
    const branch = await currentBranch(workspace, env);
    const sizeBytes = await refreshSize(workspace);
    await store.touchWorkspace(db, workspace.id, { branch, sizeBytes });
    sendJson(response, 200, { branch, output: scrubEnv(output, env) });
  }

  // ─── Environment secrets ──────────────────────────────────────────────

  async function handleEnv(op: string, body: Body, response: ServerResponse): Promise<void> {
    if (!deps.enabled)
      return sendError(
        response,
        503,
        'workspaces_unavailable',
        'Code workspaces are not enabled on this deployment.'
      );
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const key = envSecretsKey();
    if (!key) {
      return sendError(
        response,
        503,
        'env_unavailable',
        'Environment secrets need SANDBOX_ENV_SECRETS_KEY (or TOKEN_ENCRYPTION_KEY) on the sandbox worker.'
      );
    }
    switch (op) {
      case 'list': {
        const rows = await envStore.listEnvSecrets(db, target);
        return sendJson(response, 200, { variables: rows.map(envWire) });
      }
      case 'set': {
        const name = validateEnvName(body.name);
        if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
        const value = validateEnvValue(body.value);
        if (!value.ok) return sendError(response, 400, 'bad_request', value.message);
        if (
          !(await envStore.hasEnvSecret(db, target, name.name)) &&
          (await envStore.countEnvSecrets(db, target)) >= ENV_MAX_PER_SUBJECT
        ) {
          return sendError(
            response,
            429,
            'env_limit',
            `At most ${ENV_MAX_PER_SUBJECT} variables — remove one first.`
          );
        }
        const row = await envStore.upsertEnvSecret(db, {
          ...target,
          name: name.name,
          sealed: sealEnvValue(value.value, key),
        });
        return sendJson(response, 200, { variable: envWire(row) });
      }
      case 'delete': {
        const name = validateEnvName(body.name);
        if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
        const deleted = await envStore.deleteEnvSecret(db, target, name.name);
        if (!deleted) return sendError(response, 404, 'not_found');
        return sendJson(response, 200, { deleted: true, name: deleted.name });
      }
      case 'replace': {
        // The whole set at once — a pasted .env file: every name in it is
        // set, every name not in it is removed, nothing stored unless all
        // of it is acceptable. An empty map clears the caller's variables.
        if (!isRecord(body.values)) {
          return sendError(response, 400, 'bad_request', 'values must be an object.');
        }
        const entries: Array<{ name: string; value: string }> = [];
        for (const [rawName, rawValue] of Object.entries(body.values)) {
          const name = validateEnvName(rawName);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const value = validateEnvValue(rawValue);
          if (!value.ok) {
            return sendError(response, 400, 'bad_request', `${name.name}: ${value.message}`);
          }
          entries.push({ name: name.name, value: value.value });
        }
        if (entries.length > ENV_MAX_PER_SUBJECT) {
          return sendError(response, 429, 'env_limit', `At most ${ENV_MAX_PER_SUBJECT} variables.`);
        }
        const keep = new Set(entries.map((entry) => entry.name));
        for (const existing of await envStore.listEnvSecrets(db, target)) {
          if (!keep.has(existing.name)) await envStore.deleteEnvSecret(db, target, existing.name);
        }
        const rows = [];
        for (const entry of entries) {
          rows.push(
            await envStore.upsertEnvSecret(db, {
              ...target,
              name: entry.name,
              sealed: sealEnvValue(entry.value, key),
            })
          );
        }
        return sendJson(response, 200, { variables: rows.map(envWire) });
      }
      default:
        return sendError(response, 404, 'unknown_operation');
    }
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────

  type WorkspaceVerb = (
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) => Promise<void>;

  const verbs: Record<string, WorkspaceVerb> = {
    ls,
    find,
    grep,
    read,
    write,
    edit,
    exec,
    'git-status': gitStatus,
    'git-diff': gitDiff,
    'git-commit': gitCommit,
    'git-push': gitPush,
    'git-pull': gitPull,
  };

  /**
   * `/v1/workspaces/upload` — the one workspace verb whose body IS the
   * file: a person adding a file to the checkout from the project page
   * (an image, a fixture, a document) rather than the model writing
   * text. Metadata rides the query string, as the staged-file write does.
   * The bytes land as they are, uncommitted, owned by the project's uid.
   */
  async function handleUpload(url: URL, bytes: Buffer, response: ServerResponse): Promise<void> {
    if (!deps.enabled)
      return sendError(
        response,
        503,
        'workspaces_unavailable',
        'Code workspaces are not enabled on this deployment.'
      );
    const tenantId = url.searchParams.get('tenantId') ?? '';
    const subject = url.searchParams.get('subject') ?? '';
    const id = url.searchParams.get('id') ?? '';
    if (!tenantId || !subject || !id) return sendError(response, 400, 'bad_request');
    const target = { tenantId, subject };
    const path = validateWorkspacePath(url.searchParams.get('path'), { forWrite: true });
    if (!path.ok || !path.path)
      return sendError(
        response,
        400,
        'bad_path',
        path.ok ? 'A file path is required.' : path.message
      );
    if (bytes.byteLength === 0)
      return sendError(response, 400, 'bad_request', 'The request body was empty.');
    if (bytes.byteLength > UPLOAD_MAX_BYTES)
      return sendError(response, 413, 'too_large', `A file is at most ${UPLOAD_MAX_BYTES} bytes.`);
    const workspace = await loadReady(target, { id }, response);
    if (!workspace) return;
    if (workspace.sizeBytes + bytes.byteLength > WORKSPACE_MAX_BYTES) {
      return sendError(
        response,
        413,
        'quota_exceeded',
        'The workspace is over its size limit; remove some files first.'
      );
    }
    try {
      const written = await writeWorkspaceFile(
        workspaceDir(workspace.storageKey),
        path.path,
        bytes,
        identityFor(workspace)
      );
      await store.touchWorkspace(db, workspace.id);
      sendJson(response, 200, {
        path: path.path,
        created: written.created,
        sizeBytes: written.sizeBytes,
      });
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return sendError(response, 400, 'bad_path', error.message);
      }
      throw error;
    }
  }

  async function handleWorkspaces(op: string, body: Body, response: ServerResponse): Promise<void> {
    if (!deps.enabled)
      return sendError(
        response,
        503,
        'workspaces_unavailable',
        'Code workspaces are not enabled on this deployment.'
      );
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    switch (op) {
      case 'clone':
        return clone(target, body, response);
      case 'list':
        return list(target, response);
      case 'get':
        return get(target, body, response);
      case 'delete':
        return remove(target, body, response);
      default:
        break;
    }
    const verb = verbs[op];
    if (!verb) return sendError(response, 404, 'unknown_operation');
    const workspace = await loadReady(target, body, response);
    if (!workspace) return;
    const env = envSecretsEnabled() ? await openCallerEnv(db, target) : EMPTY_ENV;
    try {
      await verb(workspace, env, body, response);
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        return sendError(response, 400, 'bad_path', error.message);
      }
      throw error;
    }
  }

  /** Expired checkouts lose their bytes, then their row; one failure never stops the batch. */
  async function sweep(limit: number): Promise<void> {
    if (!deps.enabled) return;
    const expired = await store.listExpiredWorkspaces(db, limit);
    for (const workspace of expired) {
      try {
        await removeWorkspace(workspace.storageKey);
        await store.deleteWorkspaceById(db, workspace.id);
      } catch (error) {
        logger.warn('sweep could not remove workspace {id}: {error}', {
          component: 'worker-sandbox/workspaces',
          id: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { handleWorkspaces, handleUpload, handleEnv, sweep };
}

/** Exposed for tests: the contained-path check the file verbs rely on. */
export { containedPath };
