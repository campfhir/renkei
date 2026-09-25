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
  LSP_CLIENT_ID_PATTERN,
  isLanguageServerId,
  validateClientMessage,
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
  callerDirExists,
  checkoutExists,
  cloneRepository,
  containedPath,
  findFiles,
  grepFiles,
  homeDir,
  identityFor,
  listDirectory,
  measureWorkspace,
  mkdirWorkspaceFile,
  newWorkspaceStorageKey,
  readWorkspaceFile,
  orphanedByNow,
  removeWorkspace,
  removeWorkspaceFile,
  renameWorkspaceFile,
  workerInstance,
  workerUptime,
  runGit,
  runShell,
  workspaceDir,
  writeWorkspaceFile,
  type RunInput,
  type RunResult,
} from './workspaces';
import { LspSessions, probeLanguageServers } from './lsp-sessions';
import { logger } from './logger';

export interface WorkspaceHandlerDeps {
  db: Kysely<DB>;
  /** Whether workspaces are enabled on this worker at all (SANDBOX_WORKSPACES_ENABLED). */
  enabled: boolean;
  /**
   * The variables the caller's running services add to a command
   * (services.ts): SERVICE_<NAME>_HOST and friends, and each service's
   * exports. Set on top of the caller's own `.env`, so a service started
   * to be what the tests talk to is what they talk to. Absent when
   * services are off.
   */
  serviceEnv?: (target: store.WorkspaceTarget) => Promise<Record<string, string>>;
  /** The language server sessions; the handlers make their own when not given (tests share one). */
  lsp?: LspSessions;
}

const SSE_PING_MS = 15_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // Which worker answered: beside the same field on a later answer, a
    // person can see whether one worker cloned and another lost it.
    worker: workerInstance(),
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

/** A commit named by its hash or a prefix of it — never a ref, which could name anything. */
const COMMIT_SHA = /^[0-9a-f]{4,40}$/i;

/** Git's answer for the model: both streams, bounded, scrubbed by the caller. */
function gitText(result: RunResult): string {
  const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return clipOutput(text, GIT_OUTPUT_MAX_CHARS).text;
}

export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps) {
  const { db } = deps;
  const lsp = deps.lsp ?? new LspSessions();

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
    if (!(await checkoutExists(workspace.storageKey))) {
      // A ready row whose bytes are gone. Nothing here can bring it back —
      // the clone URL and the credential were the clone request's — so the
      // row says so, once, and the chat or the project page clones again.
      // Left as ready, every verb would answer a bare `spawn setpriv
      // ENOENT`. WHY it is gone is the useful part: a worker with no
      // directory for this caller at all never held the checkout (it was
      // started without the workspaces volume, or it is a second instance
      // behind the same address), while a caller directory that is there
      // minus this checkout means the checkout alone was removed.
      const callerOnDisk = await callerDirExists(workspace.storageKey);
      const where = `worker ${workerInstance()}, up ${workerUptime()}`;
      const why = callerOnDisk
        ? `this worker has the project’s other files but not this checkout, so the checkout alone was removed (${where})`
        : `this worker has no files for this project at all, so it is not the worker that cloned it — one started without the workspaces volume mounted, or a second worker instance behind the same address (${where})`;
      logger.warn('workspace {id} is ready but its checkout is missing from disk: {why}', {
        component: 'worker-sandbox/workspaces',
        id: workspace.id,
        why,
        callerOnDisk,
        worker: workerInstance(),
      });
      await store.setWorkspaceStatus(db, workspace.id, 'failed', {
        error: `The checkout is no longer on the worker’s disk: ${why}.`,
      });
      sendError(
        response,
        409,
        'not_ready',
        `That workspace’s checkout is gone from the worker’s disk: ${why}. It is now marked failed; the chat clones the repository again on its own, as does the project page.`
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
      // Measured and then checked once more: a checkout that is not there
      // straight after its own clone means this worker's disk is not
      // keeping files, and the row should say that rather than `ready`.
      if (!(await checkoutExists(storageKey))) {
        const error = `The checkout vanished right after cloning on worker ${workerInstance()} (up ${workerUptime()}): this worker’s workspaces disk is not keeping files.`;
        logger.error('workspace {id} vanished right after cloning', {
          component: 'worker-sandbox/workspaces',
          id: row.id,
          worker: workerInstance(),
        });
        await store.setWorkspaceStatus(db, row.id, 'failed', { error });
        return;
      }
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

  /**
   * The listed directory's own immediate entries .gitignore excludes —
   * shown dimmed by the tree, never hidden outright (a node_modules/
   * nobody wants browsed into is still there to see, the way an IDE's
   * own explorer greys it rather than pretending it doesn't exist).
   * `--ignored=matching` reports an ignored directory as itself, one
   * line, rather than descending into it — exactly the shallow, one-
   * level answer a directory listing needs. A quiet best-effort: a repo
   * with no `git` on this box, or any other git failure, just answers
   * no ignored paths rather than failing the listing over it.
   */
  async function ignoredPaths(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    relativePath: string
  ): Promise<Set<string>> {
    const input = runInputFor(workspace, env, 15_000);
    const result = await runGit(input, [
      'status',
      '--porcelain',
      '--ignored=matching',
      '--',
      relativePath || '.',
    ]);
    const paths = new Set<string>();
    if (result.exitCode !== 0) return paths;
    for (const line of result.stdout.split('\n')) {
      // A directory line carries a trailing slash ("ignored-dir/") that a
      // listing's own bare entry path never has.
      if (line.startsWith('!! ')) paths.add(line.slice(3).replace(/\/$/, ''));
    }
    return paths;
  }

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
    const ignored = await ignoredPaths(workspace, env, path.path);
    sendJson(response, 200, {
      path: path.path,
      entries: listed.map((entry) => ({
        ...entry,
        path: scrubEnv(entry.path, env),
        ignored: ignored.has(entry.path),
      })),
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

  /** An empty directory created in the checkout — the trailing-`/` convention. */
  async function mkdirFile(
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
        path.ok ? 'A folder path is required.' : path.message
      );
    let outcome;
    try {
      outcome = await mkdirWorkspaceFile(
        workspaceDir(workspace.storageKey),
        path.path,
        identityFor(workspace)
      );
    } catch (error) {
      if (error instanceof WorkspacePathError)
        return sendError(response, 409, 'bad_path', error.message);
      throw error;
    }
    await store.touchWorkspace(db, workspace.id);
    sendJson(response, 200, { path: path.path, created: outcome.created });
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

  /** A file or folder removed from the checkout — recursive for a folder. */
  async function removeFile(
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
        path.ok ? 'A path is required.' : path.message
      );
    let outcome;
    try {
      outcome = await removeWorkspaceFile(workspaceDir(workspace.storageKey), path.path);
    } catch (error) {
      if (error instanceof WorkspacePathError)
        return sendError(response, 400, 'bad_path', error.message);
      throw error;
    }
    if (!outcome.existed) {
      return sendError(response, 404, 'not_found', `No such file or folder: ${path.path}`);
    }
    const sizeBytes = await refreshSize(workspace);
    await store.touchWorkspace(db, workspace.id, { sizeBytes });
    sendJson(response, 200, { path: path.path, deleted: true });
  }

  /** A file or folder renamed or moved within the checkout. */
  async function moveFile(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const from = validateWorkspacePath(body.from, { forWrite: true });
    if (!from.ok || !from.path)
      return sendError(
        response,
        400,
        'bad_path',
        from.ok ? 'A source path is required.' : from.message
      );
    const to = validateWorkspacePath(body.to, { forWrite: true });
    if (!to.ok || !to.path)
      return sendError(
        response,
        400,
        'bad_path',
        to.ok ? 'A destination path is required.' : to.message
      );
    if (workspace.sizeBytes > WORKSPACE_MAX_BYTES) {
      return sendError(
        response,
        413,
        'quota_exceeded',
        'The workspace is over its size limit; remove some files first.'
      );
    }
    try {
      await renameWorkspaceFile(
        workspaceDir(workspace.storageKey),
        from.path,
        to.path,
        identityFor(workspace)
      );
    } catch (error) {
      if (error instanceof WorkspacePathError)
        return sendError(response, 409, 'move_conflict', error.message);
      throw error;
    }
    await store.touchWorkspace(db, workspace.id);
    sendJson(response, 200, { from: from.path, to: to.path });
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
    // The running services' addresses and exports, over the `.env`. Not
    // secrets — the address is the point — so they are not scrubbed.
    const serviceEnv = deps.serviceEnv ? await deps.serviceEnv(workspace) : {};
    const result = await runShell(
      runInputFor(workspace, env, timeoutMs, { extraEnv: serviceEnv }),
      command.command
    );
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
    // numstat alone can't tell a deletion from an ordinary edit — both are
    // just "some lines changed" to it. name-status's one-letter code per
    // path (M/A/D, or R for a detected rename — rare without `diff.renames`
    // configured, and folded into 'modified' below like any other line
    // this parse doesn't specially handle) is what actually says which.
    const nameStatus = await runGit(input, ['diff', '--name-status', 'HEAD', '--', ...scope]);
    const untrackedList = await runGit(input, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      ...scope,
    ]);
    const statusByPath = new Map<string, string>();
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line) continue;
      const [code, ...rest] = line.split('\t');
      const path = rest[rest.length - 1];
      if (code && path) statusByPath.set(path, code[0] ?? 'M');
    }
    const files: { path: string; added: number; deleted: number; status: string }[] = [];
    for (const line of numstat.stdout.split('\n')) {
      const [added, deleted, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!path) continue;
      const code = statusByPath.get(path);
      files.push({
        path,
        added: added === '-' ? 0 : Number(added) || 0,
        deleted: deleted === '-' ? 0 : Number(deleted) || 0,
        status: code === 'D' ? 'deleted' : code === 'A' ? 'untracked' : 'modified',
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

  /**
   * One commit as the checkout has it: its header (sha, subject, author,
   * date, parents), its diff against its first parent with per-file
   * counts, and where it stands — `pushed` when any remote branch holds
   * it, `inHead` when the current branch's history does. `commit` is a
   * sha or its prefix, never a ref: the page asks by the hash a commit
   * tool answered with, and a name could be made to mean anything.
   * `statOnly` skips the text, for a list that wants counts and state.
   */
  async function gitShow(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const wanted = str(body.commit).trim();
    if (!COMMIT_SHA.test(wanted)) {
      return sendError(response, 400, 'bad_request', 'A commit is named by its hash.');
    }
    const context =
      typeof body.context === 'number' && Number.isFinite(body.context)
        ? Math.min(DIFF_MAX_CONTEXT, Math.max(0, Math.floor(body.context)))
        : DIFF_DEFAULT_CONTEXT;
    const statOnly = body.statOnly === true;
    const input = runInputFor(workspace, env, 60_000);
    const resolved = await runGit(input, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${wanted}^{commit}`,
    ]);
    const sha = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !sha) {
      return sendError(response, 404, 'not_found', `No commit ${wanted} in the checkout.`);
    }
    const header = await runGit(input, [
      'show',
      '--no-patch',
      '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P%x00%b',
      sha,
    ]);
    const [fullSha, shortSha, subject, author, date, parents, messageBody] = header.stdout
      .trim()
      .split('\0');
    const numstat = await runGit(input, ['show', '--format=', '--numstat', sha, '--']);
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
    const patch = statOnly
      ? null
      : await runGit(input, ['show', '--format=', '--no-color', `-U${context}`, sha, '--']);
    const remote = await runGit(input, ['branch', '-r', '--contains', sha]);
    const ancestor = await runGit(input, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    const branch = await currentBranch(workspace, env);
    const text = patch?.stdout ?? '';
    const truncated = text.length > DIFF_MAX_CHARS;
    await store.touchWorkspace(db, workspace.id, { branch });
    sendJson(response, 200, {
      branch,
      commit: {
        sha: fullSha ?? sha,
        shortSha: shortSha ?? sha.slice(0, 7),
        subject: scrubEnv(subject ?? '', env),
        body: scrubEnv((messageBody ?? '').trim(), env),
        author: scrubEnv(author ?? '', env),
        date: date ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
      },
      pushed: remote.exitCode === 0 && remote.stdout.trim() !== '',
      inHead: ancestor.exitCode === 0,
      diff: scrubEnv(truncated ? text.slice(0, DIFF_MAX_CHARS) : text, env),
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

  /**
   * Every uncommitted change on the checkout discarded: `git reset --hard
   * HEAD` for tracked files, then `git clean -fd` for untracked ones —
   * the two together match everything `git status --porcelain` would
   * call dirty. Irreversible; the caller (the branch-switch route, or a
   * person's own "discard changes" action) is expected to have confirmed.
   */
  async function gitDiscard(
    workspace: store.StoredWorkspace,
    env: OpenedEnv,
    body: Body,
    response: ServerResponse
  ) {
    const input = runInputFor(workspace, env, 60_000);
    const reset = await runGit(input, ['reset', '--hard', 'HEAD']);
    if (reset.exitCode !== 0)
      return sendError(response, 409, 'git_failed', scrubEnv(gitText(reset), env));
    const cleaned = await runGit(input, ['clean', '-fd']);
    if (cleaned.exitCode !== 0)
      return sendError(response, 409, 'git_failed', scrubEnv(gitText(cleaned), env));
    const branch = await currentBranch(workspace, env);
    const sizeBytes = await refreshSize(workspace);
    await store.touchWorkspace(db, workspace.id, { branch, sizeBytes });
    sendJson(response, 200, { branch });
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
    mkdir: mkdirFile,
    edit,
    rm: removeFile,
    mv: moveFile,
    exec,
    'git-status': gitStatus,
    'git-diff': gitDiff,
    'git-show': gitShow,
    'git-commit': gitCommit,
    'git-push': gitPush,
    'git-pull': gitPull,
    'git-discard': gitDiscard,
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

  // ─── Language servers ──────────────────────────────────────────────────

  /**
   * `lsp/languages`: which servers this worker can start. `lsp/open`:
   * a server for the caller's ready checkout, its capabilities in the
   * answer. `lsp/send`: one message from the editor to it. `lsp/events`:
   * the server's messages to the editor, as a text/event-stream held
   * open. `lsp/close`: the end. A session is the caller's own: another
   * caller's id is no session at all.
   */
  async function handleLsp(
    op: string,
    target: store.WorkspaceTarget,
    body: Body,
    response: ServerResponse
  ): Promise<void> {
    if (op === 'languages') {
      return sendJson(response, 200, { languages: await probeLanguageServers() });
    }
    if (op === 'open') {
      if (!isLanguageServerId(body.server)) {
        return sendError(response, 400, 'bad_request', 'Unknown language server.');
      }
      const clientId = str(body.clientId);
      if (!LSP_CLIENT_ID_PATTERN.test(clientId)) {
        return sendError(response, 400, 'bad_request', 'A client id is required.');
      }
      const workspace = await loadReady(target, body, response);
      if (!workspace) return;
      const opened = await lsp.open({
        owner: target,
        workspaceId: workspace.id,
        rootDir: workspaceDir(workspace.storageKey),
        home: homeDir(workspace.storageKey),
        identity: identityFor(workspace),
        server: body.server,
        clientId,
      });
      if (!opened.ok) return sendError(response, opened.status, opened.type, opened.message);
      await store.touchWorkspace(db, workspace.id);
      return sendJson(response, 200, { ...opened.session, reused: opened.reused });
    }
    const session = str(body.session);
    if (!SESSION_ID.test(session)) {
      return sendError(response, 404, 'not_found', 'No such language server session.');
    }
    switch (op) {
      case 'send': {
        const rootUri = lsp.rootUriOf(session, target);
        if (!rootUri)
          return sendError(response, 404, 'not_found', 'No such language server session.');
        const checked = validateClientMessage(body.message, rootUri);
        if (!checked.ok) return sendError(response, 400, 'bad_message', checked.message);
        const sent = lsp.send(session, target, checked.message);
        if (!sent.ok) return sendError(response, sent.status, sent.type, sent.message);
        return sendJson(response, 202, { sent: true });
      }
      case 'events': {
        if (!lsp.rootUriOf(session, target)) {
          return sendError(response, 404, 'not_found', 'No such language server session.');
        }
        // Headers before the first message: attaching delivers the
        // backlog at once, and a write ahead of writeHead would send
        // the headers without the content type.
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write(': open\n\n');
        // What a server says reaches the editor scrubbed of the caller's
        // environment values, the rule every other text out keeps —
        // opened once per stream, applied to every message.
        const env = envSecretsEnabled() ? await openCallerEnv(db, target) : EMPTY_ENV;
        const subscribed = lsp.subscribe(
          session,
          target,
          (text) => {
            // One message per event; a message never contains a bare
            // newline once serialised, so one data line carries it whole.
            response.write(`data: ${text}\n\n`);
          },
          (text) => scrubEnv(text, env)
        );
        if (!subscribed.ok) {
          response.end();
          return;
        }
        const ping = setInterval(() => response.write(': ping\n\n'), SSE_PING_MS);
        response.on('close', () => {
          clearInterval(ping);
          subscribed.detach();
        });
        return;
      }
      case 'close': {
        const closed = await lsp.close(session, target);
        return sendJson(response, 200, { closed });
      }
      default:
        return sendError(response, 404, 'unknown_operation');
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
    if (op.startsWith('lsp/')) return handleLsp(op.slice('lsp/'.length), target, body, response);
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

  /**
   * Expired checkouts lose their bytes, then their row; one failure never
   * stops the batch. Only a checkout on THIS instance's disk is this
   * instance's to remove: with several instances sweeping the shared
   * rows, one on another's disk is left for that instance, until the
   * grace after which no instance has it and the row alone goes.
   */
  async function sweep(limit: number): Promise<void> {
    if (!deps.enabled) return;
    const expired = await store.listExpiredWorkspaces(db, limit);
    for (const workspace of expired) {
      try {
        if (await checkoutExists(workspace.storageKey)) {
          await removeWorkspace(workspace.storageKey);
        } else if (!orphanedByNow(workspace.expiresAt)) {
          continue;
        }
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

  return { handleWorkspaces, handleUpload, handleEnv, sweep, lsp };
}

/** Exposed for tests: the contained-path check the file verbs rely on. */
export { containedPath };
