/**
 * Project rows — the shared workspace a chat can sit in. The access
 * resolver needs the owner and the publish flag; the project pages need
 * the rest. Membership is resource_access_grants (access.ts).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
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
  tenantId: string;
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
  /** A code project's checkout on the sandbox worker, once cloned. */
  workspaceId: string | null;
  /**
   * A code project's one chat that may continue (lib/code/active-chat.ts);
   * every other chat in it is history. Null on a chat project, and on a
   * code project whose active chat was deleted or archived.
   */
  activeChatId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const PROJECT_COLUMNS = [
  'id',
  'tenant_id',
  'owner_subject',
  'kind',
  'name',
  'description',
  'instructions',
  'tool_config',
  'repo_provider',
  'repo_full_name',
  'repo_branch',
  'workspace_id',
  'active_chat_id',
  'created_at',
  'updated_at',
] as const;

export const PROJECT_NAME_MAX_CHARS = 200;
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 20_000;

function rowOf(raw: {
  id: string;
  tenant_id: string;
  owner_subject: string;
  kind: string;
  name: string;
  description: string | null;
  instructions: string | null;
  tool_config: unknown;
  repo_provider: string | null;
  repo_full_name: string | null;
  repo_branch: string | null;
  workspace_id: string | null;
  active_chat_id: string | null;
  created_at: Date;
  updated_at: Date;
}): ProjectRow {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    ownerSubject: raw.owner_subject,
    kind: raw.kind === 'code' ? 'code' : 'chat',
    name: raw.name,
    description: raw.description,
    sealedInstructions: raw.instructions,
    toolConfig: parseToolConfig(raw.tool_config),
    repo:
      raw.kind === 'code' && raw.repo_provider && raw.repo_full_name
        ? {
            provider: raw.repo_provider,
            fullName: raw.repo_full_name,
            branch: raw.repo_branch ?? '',
          }
        : null,
    workspaceId: raw.workspace_id,
    activeChatId: raw.kind === 'code' ? raw.active_chat_id : null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** The project's instructions, opened under its cipher; null when none are set. */
export function openProjectInstructions(
  project: Pick<ProjectRow, 'sealedInstructions'>,
  cipher: ContentCipher
): string | null {
  return project.sealedInstructions ? openText(project.sealedInstructions, cipher) : null;
}

export async function getProjectRow(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string
): Promise<ProjectRow | null> {
  if (!isUuid(projectId)) return null;
  const raw = await db
    .selectFrom('chat_projects')
    .select(PROJECT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', projectId)
    .executeTakeFirst();
  return raw ? rowOf(raw) : null;
}

export async function listOwnedProjects(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string
): Promise<ProjectRow[]> {
  const rows = await db
    .selectFrom('chat_projects')
    .select(PROJECT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map(rowOf);
}

export async function listProjectsById(
  db: Kysely<DB>,
  tenantId: string,
  projectIds: string[]
): Promise<ProjectRow[]> {
  const ids = projectIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('chat_projects')
    .select(PROJECT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', ids)
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map(rowOf);
}

export async function createProject(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    ownerSubject: string;
    name: string;
    description: string | null;
    instructions: string | null;
    toolConfig: ChatToolConfig | null;
    /** A code project names its repository; absent means a chat project. */
    repo?: ProjectRepo;
  }
): Promise<string | null> {
  const inserted = await db
    .insertInto('chat_projects')
    .values({
      tenant_id: input.tenantId,
      owner_subject: input.ownerSubject,
      name: input.name,
      description: input.description,
      instructions: null,
      tool_config: input.toolConfig ? toolConfigJson(input.toolConfig) : null,
      ...(input.repo
        ? {
            kind: 'code',
            repo_provider: input.repo.provider,
            repo_full_name: input.repo.fullName,
            repo_branch: input.repo.branch || null,
          }
        : {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // The project's own key, wrapped for its owner (chat-keys.ts): its
  // instructions, memory and files are sealed under it.
  const key = await createKey(db, 'chat_project', {
    id: inserted.id,
    tenantId: input.tenantId,
    ownerSubject: input.ownerSubject,
  });
  if (input.instructions) {
    const sealed = key ? sealText(input.instructions, resourceCipher(key)) : null;
    if (!sealed || !sealed.ok) {
      await db.deleteFrom('chat_projects').where('id', '=', inserted.id).execute();
      return null;
    }
    await db
      .updateTable('chat_projects')
      .set({ instructions: sealed.val })
      .where('id', '=', inserted.id)
      .execute();
  }
  return inserted.id;
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
  /** The chat that may continue in a code project; null when none may. */
  activeChatId?: string | null;
}

/**
 * Keyed by project id only — the caller has already resolved edit rights,
 * and hands over the project's cipher (ProjectAccess.cipher) when the
 * patch carries instructions to seal.
 */
export async function updateProject(
  db: Kysely<DB>,
  tenantId: string,
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
  const result = await db
    .updateTable('chat_projects')
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(patch.toolConfig !== undefined
        ? { tool_config: patch.toolConfig ? toolConfigJson(patch.toolConfig) : null }
        : {}),
      ...(patch.repo !== undefined
        ? {
            repo_provider: patch.repo.provider,
            repo_full_name: patch.repo.fullName,
            repo_branch: patch.repo.branch || null,
          }
        : {}),
      ...(patch.workspaceId !== undefined ? { workspace_id: patch.workspaceId } : {}),
      ...(patch.activeChatId !== undefined ? { active_chat_id: patch.activeChatId } : {}),
      updated_at: sql<Date>`NOW()`,
    })
    .where('tenant_id', '=', tenantId)
    .where('id', '=', projectId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function deleteProject(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  projectId: string
): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const result = await db
    .deleteFrom('chat_projects')
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', projectId)
    .executeTakeFirst();
  const deleted = Number(result.numDeletedRows) > 0;
  if (deleted) {
    await db
      .deleteFrom('resource_access_grants')
      .where('tenant_id', '=', tenantId)
      .where('resource_kind', '=', 'chat_project')
      .where('resource_id', '=', projectId)
      .execute();
    await deleteKey(db, 'chat_project', tenantId, projectId);
  }
  return deleted;
}
