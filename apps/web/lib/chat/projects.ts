/**
 * Project rows — the shared workspace a chat can sit in. The access
 * resolver needs the owner and the publish flag; the project pages need
 * the rest. Membership is resource_access_grants (access.ts).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { parseToolConfig, toolConfigJson, type ChatToolConfig } from './tool-config';
import { openText, sealText } from './content-crypto';

export interface ProjectRow {
  id: string;
  tenantId: string;
  ownerSubject: string;
  name: string;
  description: string | null;
  /** Decrypted; null when none set. */
  instructions: string | null;
  toolConfig: ChatToolConfig | null;
  publishedToOrg: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PROJECT_COLUMNS = [
  'id',
  'tenant_id',
  'owner_subject',
  'name',
  'description',
  'instructions',
  'tool_config',
  'published_to_org',
  'created_at',
  'updated_at',
] as const;

export const PROJECT_NAME_MAX_CHARS = 200;
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 20_000;

function rowOf(raw: {
  id: string;
  tenant_id: string;
  owner_subject: string;
  name: string;
  description: string | null;
  instructions: string | null;
  tool_config: unknown;
  published_to_org: boolean;
  created_at: Date;
  updated_at: Date;
}): ProjectRow {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    ownerSubject: raw.owner_subject,
    name: raw.name,
    description: raw.description,
    instructions: raw.instructions ? openText(raw.instructions) : null,
    toolConfig: parseToolConfig(raw.tool_config),
    publishedToOrg: raw.published_to_org,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
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

export async function listPublishedProjects(
  db: Kysely<DB>,
  tenantId: string
): Promise<ProjectRow[]> {
  const rows = await db
    .selectFrom('chat_projects')
    .select(PROJECT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('published_to_org', '=', true)
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
  }
): Promise<string | null> {
  let instructions: string | null = null;
  if (input.instructions) {
    const sealed = sealText(input.instructions);
    if (!sealed.ok) return null;
    instructions = sealed.val;
  }
  const inserted = await db
    .insertInto('chat_projects')
    .values({
      tenant_id: input.tenantId,
      owner_subject: input.ownerSubject,
      name: input.name,
      description: input.description,
      instructions,
      tool_config: input.toolConfig ? toolConfigJson(input.toolConfig) : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export interface ProjectPatch {
  name?: string;
  description?: string | null;
  instructions?: string | null;
  toolConfig?: ChatToolConfig | null;
  publishedToOrg?: boolean;
}

/** Keyed by project id only — the caller has already resolved edit rights. */
export async function updateProject(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string,
  patch: ProjectPatch
): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  let instructions: string | null | undefined;
  if (patch.instructions !== undefined) {
    if (patch.instructions) {
      const sealed = sealText(patch.instructions);
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
      ...(patch.publishedToOrg !== undefined ? { published_to_org: patch.publishedToOrg } : {}),
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
  }
  return deleted;
}
