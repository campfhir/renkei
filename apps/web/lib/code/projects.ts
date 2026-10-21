/**
 * What makes a project a code project, on top of lib/chat/projects.ts:
 * the checkout on the sandbox worker and the environment its commands
 * run with. Both live on the worker under the PROJECT's scope
 * (lib/code/scope.ts), so this module is where the project row and the
 * worker are kept in step — a clone started and recorded, an `.env`
 * replaced, a project deleted with its checkout and variables.
 *
 * A clone spends the person's own grant on the project's git host
 * (Bitbucket or GitHub): the caller resolves the credential
 * (lib/sandbox/workspace-git.ts) and hands it here for one worker call;
 * nothing keeps it.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { parseDotenv, validateRepoFullName } from '@renkei/connector-sandbox';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbEnvList,
  sbEnvReplace,
  sbWorkspaceClone,
  sbWorkspaceDelete,
  sbWorkspaceGet,
  sbWorkspaceWorktree,
  type WireEnvVariable,
  type WireWorkspace,
} from '@renkei/sandbox-client';
import { deleteProject, getProjectRow, updateProject, type ProjectRow } from '@/lib/chat/projects';
import type { GitProxy } from '@renkei/sandbox-client';
import { cloneUrlFor, type WorkspaceGitAccess } from '@/lib/sandbox/workspace-git';
import { codeProjectTarget } from './scope';

export type CodeOutcome<T> = { ok: true; val: T } | { ok: false; status: number; message: string };

/**
 * Clone the project's repository into a fresh checkout on the worker and
 * record it on the row. An earlier checkout, if any, is dropped first —
 * one project, one checkout.
 */
export async function startProjectClone(
  db: Kysely<DB>,
  project: ProjectRow,
  credential: WorkspaceGitAccess,
  options: { depth?: number } = {}
): Promise<CodeOutcome<WireWorkspace>> {
  if (!(await sandboxWorkspacesEnabled())) {
    return {
      ok: false,
      status: 503,
      message: 'Code workspaces are not enabled for this organization.',
    };
  }
  if (!project.repo) return { ok: false, status: 400, message: 'The project names no repository.' };
  const repo = validateRepoFullName(project.repo.fullName);
  if (!repo.ok) return { ok: false, status: 400, message: repo.message };
  const target = codeProjectTarget(project.id);
  if (project.workspaceId) {
    // Best effort: a checkout the sweep already retired is simply gone.
    await sbWorkspaceDelete(target, project.workspaceId);
    await updateProject(db, project.id, { workspaceId: null });
  }
  const cloned = await sbWorkspaceClone(target, {
    provider: project.repo.provider,
    repoFullName: repo.fullName,
    ...(project.repo.branch ? { branch: project.repo.branch } : {}),
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    cloneUrl: cloneUrlFor(project.repo.provider, repo.workspace, repo.repoSlug),
    gitProxy: credential.gitProxy,
  });
  if (!cloned.ok) {
    const failure = clientFailure(cloned.err);
    return { ok: false, status: failure.status, message: failure.message };
  }
  await updateProject(db, project.id, { workspaceId: cloned.val.id });
  return { ok: true, val: cloned.val };
}

/** The branch a chat's worktree starts on, named for the chat so it can be found again. */
export function chatBranchName(chatId: string): string {
  // The id's last group: 48 random bits in a v4 UUID, so no two chats share a branch
  // (the worker answers the same worktree for the same branch).
  return `renkei/${chatId.slice(-12)}`;
}

/**
 * Give a chat its own worktree of the project's base clone and record it on
 * the chat. Several chats in one project each work in one of these at the
 * same time, so none of them sees another's uncommitted files or branch
 * switches. Asked again for a chat that has one, the worker answers the
 * same worktree.
 */
export async function startChatWorktree(
  db: Kysely<DB>,
  project: ProjectRow,
  chatId: string,
  base: WireWorkspace,
  gitProxy?: GitProxy
): Promise<CodeOutcome<WireWorkspace>> {
  const made = await sbWorkspaceWorktree(codeProjectTarget(project.id), {
    baseId: base.id,
    branch: chatBranchName(chatId),
    ...(project.repo?.branch ? { startBranch: project.repo.branch } : {}),
    ...(gitProxy ? { gitProxy } : {}),
  });
  if (!made.ok) {
    const failure = clientFailure(made.err);
    return { ok: false, status: failure.status, message: failure.message };
  }
  await db
    .updateTable('chats')
    .set({ workspace_id: made.val.id })
    .where('id', '=', chatId)
    .execute();
  return { ok: true, val: made.val };
}

/** The chat's worktree as the worker sees it now, or null when it has none. */
export async function chatWorkspace(
  project: ProjectRow,
  chat: { workspaceId: string | null }
): Promise<WireWorkspace | null> {
  if (!chat.workspaceId || !(await sandboxWorkspacesEnabled())) return null;
  const got = await sbWorkspaceGet(codeProjectTarget(project.id), chat.workspaceId);
  return got.ok ? got.val : null;
}

/**
 * A checkout as the worker sees it now, or null when there is none to see:
 * the project's base clone, or — named — a chat's worktree.
 */
export async function projectWorkspace(
  project: ProjectRow,
  workspaceId: string | null = project.workspaceId
): Promise<WireWorkspace | null> {
  if (!workspaceId || !(await sandboxWorkspacesEnabled())) return null;
  const got = await sbWorkspaceGet(codeProjectTarget(project.id), workspaceId);
  return got.ok ? got.val : null;
}

export async function projectEnv(project: ProjectRow): Promise<WireEnvVariable[]> {
  if (!(await sandboxWorkspacesEnabled())) return [];
  const listed = await sbEnvList(codeProjectTarget(project.id));
  return listed.ok ? listed.val : [];
}

/**
 * Replace the project's environment from the text of a `.env` file. The
 * text is parsed here and only the name/value pairs travel to the
 * worker, which seals them; lines that were not variables are reported
 * back so the person sees what did not take.
 */
export async function replaceProjectEnv(
  project: ProjectRow,
  dotenvText: string
): Promise<CodeOutcome<{ variables: WireEnvVariable[]; problems: string[] }>> {
  if (!(await sandboxWorkspacesEnabled())) {
    return {
      ok: false,
      status: 503,
      message: 'Code workspaces are not enabled for this organization.',
    };
  }
  const parsed = parseDotenv(dotenvText);
  const replaced = await sbEnvReplace(codeProjectTarget(project.id), parsed.values);
  if (!replaced.ok) {
    const failure = clientFailure(replaced.err);
    return { ok: false, status: failure.status, message: failure.message };
  }
  return { ok: true, val: { variables: replaced.val, problems: parsed.problems } };
}

/** A chat's worktree taken away with the chat — best effort, the worker's sweep gets what this misses. */
export async function deleteChatWorktree(
  projectId: string,
  workspaceId: string | null
): Promise<void> {
  if (!workspaceId || !(await sandboxWorkspacesEnabled())) return;
  await sbWorkspaceDelete(codeProjectTarget(projectId), workspaceId);
}

/** The project row, its checkout and its variables gone together. */
export async function deleteCodeProject(
  db: Kysely<DB>,
  ownerSubject: string,
  projectId: string
): Promise<boolean> {
  const project = await getProjectRow(db, projectId);
  if (!project || project.ownerSubject !== ownerSubject) return false;
  const deleted = await deleteProject(db, ownerSubject, projectId);
  if (!deleted) return false;
  if (await sandboxWorkspacesEnabled()) {
    const target = codeProjectTarget(projectId);
    // Best effort, after the row: what the worker still holds expires on
    // its own if this does not reach it.
    if (project.workspaceId) await sbWorkspaceDelete(target, project.workspaceId);
    await sbEnvReplace(target, {});
  }
  return true;
}
