/**
 * What makes a project a code project, on top of lib/chat/projects.ts:
 * the checkout on the sandbox worker and the environment its commands
 * run with. Both live on the worker under the PROJECT's scope
 * (lib/code/scope.ts), so this module is where the project row and the
 * worker are kept in step — a clone started and recorded, an `.env`
 * replaced, a project deleted with its checkout and variables.
 *
 * A clone spends the person's own Bitbucket grant: the caller resolves
 * the credential (lib/sandbox/workspace-git.ts) and hands it here for
 * one worker call; nothing keeps it.
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
  type WireEnvVariable,
  type WireWorkspace,
} from '@renkei/sandbox-client';
import { deleteProject, getProjectRow, updateProject, type ProjectRow } from '@/lib/chat/projects';
import { bitbucketCloneUrl, type WorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
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
  credential: WorkspaceGitCredential,
  options: { depth?: number } = {}
): Promise<CodeOutcome<WireWorkspace>> {
  if (!sandboxWorkspacesEnabled()) {
    return {
      ok: false,
      status: 503,
      message: 'Code workspaces are not enabled on this deployment.',
    };
  }
  if (!project.repo) return { ok: false, status: 400, message: 'The project names no repository.' };
  const repo = validateRepoFullName(project.repo.fullName);
  if (!repo.ok) return { ok: false, status: 400, message: repo.message };
  const target = codeProjectTarget(project.tenantId, project.id);
  if (project.workspaceId) {
    // Best effort: a checkout the sweep already retired is simply gone.
    await sbWorkspaceDelete(target, project.workspaceId);
    await updateProject(db, project.tenantId, project.id, { workspaceId: null });
  }
  const cloned = await sbWorkspaceClone(target, {
    provider: project.repo.provider,
    repoFullName: repo.fullName,
    ...(project.repo.branch ? { branch: project.repo.branch } : {}),
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    cloneUrl: bitbucketCloneUrl(repo.workspace, repo.repoSlug),
    authHeader: credential.authHeader,
  });
  if (!cloned.ok) {
    const failure = clientFailure(cloned.err);
    return { ok: false, status: failure.status, message: failure.message };
  }
  await updateProject(db, project.tenantId, project.id, { workspaceId: cloned.val.id });
  return { ok: true, val: cloned.val };
}

/** The checkout as the worker sees it now, or null when there is none to see. */
export async function projectWorkspace(project: ProjectRow): Promise<WireWorkspace | null> {
  if (!project.workspaceId || !sandboxWorkspacesEnabled()) return null;
  const got = await sbWorkspaceGet(
    codeProjectTarget(project.tenantId, project.id),
    project.workspaceId
  );
  return got.ok ? got.val : null;
}

export async function projectEnv(project: ProjectRow): Promise<WireEnvVariable[]> {
  if (!sandboxWorkspacesEnabled()) return [];
  const listed = await sbEnvList(codeProjectTarget(project.tenantId, project.id));
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
  if (!sandboxWorkspacesEnabled()) {
    return {
      ok: false,
      status: 503,
      message: 'Code workspaces are not enabled on this deployment.',
    };
  }
  const parsed = parseDotenv(dotenvText);
  const replaced = await sbEnvReplace(
    codeProjectTarget(project.tenantId, project.id),
    parsed.values
  );
  if (!replaced.ok) {
    const failure = clientFailure(replaced.err);
    return { ok: false, status: failure.status, message: failure.message };
  }
  return { ok: true, val: { variables: replaced.val, problems: parsed.problems } };
}

/** The project row, its checkout and its variables gone together. */
export async function deleteCodeProject(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  projectId: string
): Promise<boolean> {
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.ownerSubject !== ownerSubject) return false;
  const deleted = await deleteProject(db, tenantId, ownerSubject, projectId);
  if (!deleted) return false;
  if (sandboxWorkspacesEnabled()) {
    const target = codeProjectTarget(tenantId, projectId);
    // Best effort, after the row: what the worker still holds expires on
    // its own if this does not reach it.
    if (project.workspaceId) await sbWorkspaceDelete(target, project.workspaceId);
    await sbEnvReplace(target, {});
  }
  return true;
}
