/**
 * Project rows — the shared workspace a chat can sit in. The access
 * resolver needs the owner and the publish flag; the project pages need
 * the rest. Membership is resource_access_grants (access.ts).
 */

import { getDataStore, type ChatProjectRecord } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { parseToolConfig, toolConfigJson, type ChatToolConfig } from './tool-config';
import { openText, resourceCipher, sealText, type ContentCipher } from './content-crypto';
import { createKey, deleteKey } from './chat-keys';

/**
 * A chat project, or a code project: the latter is the same row with a
 * repository on it — a checkout on the sandbox worker and an environment
 * its commands run with (migration 102, docs/sandbox-workspaces-design.md).
 */
export type ProjectKind = 'chat' | 'code';

export interface ProjectRepo {
  provider: string;
  /** `workspace/repo`, as the provider names it. */
  fullName: string;
  /** Empty means the repository's default branch. */
  branch: string;
}

export interface ProjectRow {
  id: string;
  ownerSubject: string;
  kind: ProjectKind;
  name: string;
  description: string | null;
  /**
   * The instructions as stored — sealed under the project's key. Opened
   * with `openProjectInstructions` by the callers that need the text and
   * hold the project's cipher (access.ts's ProjectAccess); most readers of
   * a row need only its metadata.
   */
  sealedInstructions: string | null;
  toolConfig: ChatToolConfig | null;
  /** A code project's repository; null on a chat project. */
  repo: ProjectRepo | null;
  /** A code project's base clone on the sandbox worker, once cloned; each chat works in a worktree of it (chats.workspace_id). */
  workspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PROJECT_NAME_MAX_CHARS = 200;
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 20_000;

function rowOf(raw: ChatProjectRecord): ProjectRow {
  return {
    id: raw.id,
    ownerSubject: raw.ownerSubject,
    kind: raw.kind === 'code' ? 'code' : 'chat',
    name: raw.name,
    description: raw.description,
    sealedInstructions: raw.instructions,
    toolConfig: parseToolConfig(raw.toolConfig),
    repo:
      raw.kind === 'code' && raw.repoProvider && raw.repoFullName
        ? {
            provider: raw.repoProvider,
            fullName: raw.repoFullName,
            branch: raw.repoBranch ?? '',
          }
        : null,
    workspaceId: raw.workspaceId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** The project's instructions, opened under its cipher; null when none are set. */
export function openProjectInstructions(
  project: Pick<ProjectRow, 'sealedInstructions'>,
  cipher: ContentCipher
): string | null {
  return project.sealedInstructions ? openText(project.sealedInstructions, cipher) : null;
}

export async function getProjectRow(projectId: string): Promise<ProjectRow | null> {
  if (!isUuid(projectId)) return null;
  const raw = await getDataStore().chatProjects.get(projectId);
  return raw ? rowOf(raw) : null;
}

export async function listOwnedProjects(ownerSubject: string): Promise<ProjectRow[]> {
  return (await getDataStore().chatProjects.listOwned(ownerSubject)).map(rowOf);
}

/** These projects, most recently updated first — or, `orderBy: 'name'`, by name. */
export async function listProjectsById(
  projectIds: string[],
  options: { orderBy?: 'updated' | 'name' } = {}
): Promise<ProjectRow[]> {
  const ids = projectIds.filter(isUuid);
  if (ids.length === 0) return [];
  return (await getDataStore().chatProjects.listByIds(ids, options)).map(rowOf);
}

export async function createProject(input: {
  ownerSubject: string;
  name: string;
  description: string | null;
  instructions: string | null;
  toolConfig: ChatToolConfig | null;
  /** A code project names its repository; absent means a chat project. */
  repo?: ProjectRepo;
}): Promise<string | null> {
  const store = getDataStore();
  const id = await store.chatProjects.create({
    ownerSubject: input.ownerSubject,
    name: input.name,
    description: input.description,
    toolConfig: input.toolConfig ? toolConfigJson(input.toolConfig) : null,
    ...(input.repo
      ? {
          repo: {
            provider: input.repo.provider,
            fullName: input.repo.fullName,
            branch: input.repo.branch || null,
          },
        }
      : {}),
  });
  // The project's own key, wrapped for its owner (chat-keys.ts): its
  // instructions, memory and files are sealed under it.
  const key = await createKey('chat_project', { id, ownerSubject: input.ownerSubject });
  if (input.instructions) {
    const sealed = key ? sealText(input.instructions, resourceCipher(key)) : null;
    if (!sealed || !sealed.ok) {
      await store.chatProjects.delete(input.ownerSubject, id);
      return null;
    }
    await store.chatProjects.update(id, { instructions: sealed.val });
  }
  return id;
}

export interface ProjectPatch {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  toolConfig?: ChatToolConfig | null;
  /** A code project's repository, when it is re-pointed. */
  repo?: ProjectRepo;
  /** The checkout on the worker: set when a clone starts, cleared when it is dropped. */
  workspaceId?: string | null;
}

/**
 * Keyed by project id only — the caller has already resolved edit rights,
 * and hands over the project's cipher (ProjectAccess.cipher) when the
 * patch carries instructions to seal.
 */
export async function updateProject(
  projectId: string,
  patch: ProjectPatch,
  cipher?: ContentCipher
): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  let instructions: string | null | undefined;
  if (patch.instructions !== undefined) {
    if (patch.instructions) {
      if (!cipher) return false;
      const sealed = sealText(patch.instructions, cipher);
      if (!sealed.ok) return false;
      instructions = sealed.val;
    } else {
      instructions = null;
    }
  }
  return getDataStore().chatProjects.update(projectId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(patch.toolConfig !== undefined
      ? { toolConfig: patch.toolConfig ? toolConfigJson(patch.toolConfig) : null }
      : {}),
    ...(patch.repo !== undefined
      ? {
          repo: {
            provider: patch.repo.provider,
            fullName: patch.repo.fullName,
            branch: patch.repo.branch || null,
          },
        }
      : {}),
    ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
  });
}

export async function deleteProject(ownerSubject: string, projectId: string): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const store = getDataStore();
  const deleted = await store.chatProjects.delete(ownerSubject, projectId);
  if (deleted) {
    await store.resourceGrants.deleteForResource('chat_project', projectId);
    await deleteKey('chat_project', projectId);
  }
  return deleted;
}
