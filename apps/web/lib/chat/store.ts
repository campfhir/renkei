/**
 * Chats and their rows — the data layer under every chat surface.
 *
 * Ownership is structural: a chat is written only under its owner's
 * subject, so someone else's chat resolves to "not found" from every
 * mutation. Reading is broader (access.ts decides who may view what);
 * this module only knows how to fetch and change rows.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { parseToolConfig, toolConfigJson, type ChatToolConfig } from './tool-config';

export interface ChatRow {
  id: string;
  tenantId: string;
  ownerSubject: string;
  projectId: string | null;
  title: string | null;
  llmModelId: string | null;
  toolConfig: ChatToolConfig | null;
  thinkingEnabled: boolean;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CHAT_COLUMNS = [
  'id',
  'tenant_id',
  'owner_subject',
  'project_id',
  'title',
  'llm_model_id',
  'tool_config',
  'thinking_enabled',
  'last_message_at',
  'archived_at',
  'created_at',
  'updated_at',
] as const;

/** The sidebar's ceiling — beyond it, search narrows. */
export const CHAT_LIST_LIMIT = 200;

type RawChat = {
  id: string;
  tenant_id: string;
  owner_subject: string;
  project_id: string | null;
  title: string | null;
  llm_model_id: string | null;
  tool_config: unknown;
  thinking_enabled: boolean;
  last_message_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function rowOf(raw: RawChat): ChatRow {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    ownerSubject: raw.owner_subject,
    projectId: raw.project_id,
    title: raw.title,
    llmModelId: raw.llm_model_id,
    toolConfig: parseToolConfig(raw.tool_config),
    thinkingEnabled: raw.thinking_enabled,
    lastMessageAt: raw.last_message_at,
    archivedAt: raw.archived_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function getChatRow(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string
): Promise<ChatRow | null> {
  if (!isUuid(chatId)) return null;
  const raw = await db
    .selectFrom('chats')
    .select(CHAT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', chatId)
    .executeTakeFirst();
  return raw ? rowOf(raw) : null;
}

export async function getChatForOwner(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  chatId: string
): Promise<ChatRow | null> {
  const row = await getChatRow(db, tenantId, chatId);
  return row && row.ownerSubject === ownerSubject ? row : null;
}

export async function listOwnedChats(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  options: { includeArchived?: boolean } = {}
): Promise<ChatRow[]> {
  let query = db
    .selectFrom('chats')
    .select(CHAT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject);
  if (!options.includeArchived) query = query.where('archived_at', 'is', null);
  const rows = await query.orderBy('updated_at', 'desc').limit(CHAT_LIST_LIMIT).execute();
  return rows.map(rowOf);
}

/** Chats sitting in these projects, other than the viewer's own. */
export async function listProjectChats(
  db: Kysely<DB>,
  tenantId: string,
  projectIds: string[],
  excludeOwner: string | null
): Promise<ChatRow[]> {
  if (projectIds.length === 0) return [];
  let query = db
    .selectFrom('chats')
    .select(CHAT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('project_id', 'in', projectIds)
    .where('archived_at', 'is', null);
  if (excludeOwner) query = query.where('owner_subject', '!=', excludeOwner);
  const rows = await query.orderBy('updated_at', 'desc').limit(CHAT_LIST_LIMIT).execute();
  return rows.map(rowOf);
}

export async function listChatsById(
  db: Kysely<DB>,
  tenantId: string,
  chatIds: string[]
): Promise<ChatRow[]> {
  const ids = chatIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('chats')
    .select(CHAT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', 'in', ids)
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map(rowOf);
}

export async function createChat(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    ownerSubject: string;
    projectId: string | null;
    llmModelId: string | null;
    toolConfig: ChatToolConfig | null;
    thinkingEnabled: boolean;
  }
): Promise<string> {
  const inserted = await db
    .insertInto('chats')
    .values({
      tenant_id: input.tenantId,
      owner_subject: input.ownerSubject,
      project_id: input.projectId,
      llm_model_id: input.llmModelId,
      tool_config: input.toolConfig ? toolConfigJson(input.toolConfig) : null,
      thinking_enabled: input.thinkingEnabled,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export interface ChatPatch {
  title?: string | null;
  llmModelId?: string | null;
  toolConfig?: ChatToolConfig | null;
  thinkingEnabled?: boolean;
  archived?: boolean;
}

export async function updateChat(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  chatId: string,
  patch: ChatPatch
): Promise<boolean> {
  if (!isUuid(chatId)) return false;
  const result = await db
    .updateTable('chats')
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.llmModelId !== undefined ? { llm_model_id: patch.llmModelId } : {}),
      ...(patch.toolConfig !== undefined
        ? { tool_config: patch.toolConfig ? toolConfigJson(patch.toolConfig) : null }
        : {}),
      ...(patch.thinkingEnabled !== undefined ? { thinking_enabled: patch.thinkingEnabled } : {}),
      ...(patch.archived !== undefined
        ? { archived_at: patch.archived ? sql<Date>`NOW()` : null }
        : {}),
      updated_at: sql<Date>`NOW()`,
    })
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', chatId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Moving is only a project_id change; the chat keeps everything else. */
export async function moveChatToProject(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  chatId: string,
  projectId: string | null
): Promise<boolean> {
  if (!isUuid(chatId)) return false;
  const result = await db
    .updateTable('chats')
    .set({ project_id: projectId, updated_at: sql<Date>`NOW()` })
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', chatId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function deleteChat(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  chatId: string
): Promise<boolean> {
  if (!isUuid(chatId)) return false;
  const result = await db
    .deleteFrom('chats')
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', chatId)
    .executeTakeFirst();
  const deleted = Number(result.numDeletedRows) > 0;
  if (deleted) {
    await db
      .deleteFrom('resource_access_grants')
      .where('tenant_id', '=', tenantId)
      .where('resource_kind', '=', 'chat')
      .where('resource_id', '=', chatId)
      .execute();
  }
  return deleted;
}

/** Bumps activity; sets the title only while the chat has none. */
export async function touchChat(
  db: Kysely<DB>,
  chatId: string,
  input: { titleIfMissing?: string; llmModelId?: string | null }
): Promise<void> {
  await db
    .updateTable('chats')
    .set({
      last_message_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
      ...(input.titleIfMissing !== undefined
        ? { title: sql<string>`COALESCE(title, ${input.titleIfMissing})` }
        : {}),
      ...(input.llmModelId !== undefined ? { llm_model_id: input.llmModelId } : {}),
    })
    .where('id', '=', chatId)
    .execute();
}
