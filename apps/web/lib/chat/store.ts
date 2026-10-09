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
import { createKey, deleteKey, wrapKeyUnderProject } from './chat-keys';

export interface ChatRow {
  id: string;
  ownerSubject: string;
  projectId: string | null;
  title: string | null;
  llmModelId: string | null;
  toolConfig: ChatToolConfig | null;
  thinkingEnabled: boolean;
  /** See ChatView.autoMode. */
  autoMode: boolean;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CHAT_COLUMNS = [
  'id',
  'owner_subject',
  'project_id',
  'title',
  'llm_model_id',
  'tool_config',
  'thinking_enabled',
  'auto_mode',
  'last_message_at',
  'archived_at',
  'created_at',
  'updated_at',
] as const;

/** The sidebar's ceiling — beyond it, search narrows. */
export const CHAT_LIST_LIMIT = 200;

type RawChat = {
  id: string;
  owner_subject: string;
  project_id: string | null;
  title: string | null;
  llm_model_id: string | null;
  tool_config: unknown;
  thinking_enabled: boolean;
  auto_mode: boolean;
  last_message_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function rowOf(raw: RawChat): ChatRow {
  return {
    id: raw.id,
    ownerSubject: raw.owner_subject,
    projectId: raw.project_id,
    title: raw.title,
    llmModelId: raw.llm_model_id,
    toolConfig: parseToolConfig(raw.tool_config),
    thinkingEnabled: raw.thinking_enabled,
    autoMode: raw.auto_mode,
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
  options: {
    includeArchived?: boolean;
    /** Only chats touched at or after this instant. */
    since?: Date;
    /** Only chats touched before this instant — the "load more" cursor. */
    before?: Date;
    limit?: number;
  } = {}
): Promise<ChatRow[]> {
  let query = db
    .selectFrom('chats')
    .select(CHAT_COLUMNS)
    .where('owner_subject', '=', ownerSubject);
  if (!options.includeArchived) query = query.where('archived_at', 'is', null);
  if (options.since) query = query.where('updated_at', '>=', options.since);
  if (options.before) query = query.where('updated_at', '<', options.before);
  const rows = await query
    .orderBy('updated_at', 'desc')
    .limit(options.limit ?? CHAT_LIST_LIMIT)
    .execute();
  return rows.map(rowOf);
}

/** Whether the owner has a chat touched before `before` — the "load more" button's cue to appear. */
export async function hasOwnedChatBefore(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  before: Date
): Promise<boolean> {
  const row = await db
    .selectFrom('chats')
    .select('id')
    .where('owner_subject', '=', ownerSubject)
    .where('updated_at', '<', before)
    .where('last_message_at', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Chats sitting in these projects, other than the viewer's own. */
export async function listProjectChats(
  db: Kysely<DB>,
  tenantId: string,
  projectIds: string[],
  excludeOwner: string | null,
  options: { since?: Date } = {}
): Promise<ChatRow[]> {
  if (projectIds.length === 0) return [];
  let query = db
    .selectFrom('chats')
    .select(CHAT_COLUMNS)
    .where('project_id', 'in', projectIds)
    .where('archived_at', 'is', null);
  if (excludeOwner) query = query.where('owner_subject', '!=', excludeOwner);
  if (options.since) query = query.where('updated_at', '>=', options.since);
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
    .where('id', 'in', ids)
    .orderBy('updated_at', 'desc')
    .execute();
  return rows.map(rowOf);
}

export async function createChat(
  db: Kysely<DB>,
  input: {
    ownerSubject: string;
    projectId: string | null;
    llmModelId: string | null;
    toolConfig: ChatToolConfig | null;
    thinkingEnabled: boolean;
    /** See ChatRow.autoMode. Defaults to off — callers opt in. */
    autoMode?: boolean;
  }
): Promise<string> {
  const inserted = await db
    .insertInto('chats')
    .values({
      owner_subject: input.ownerSubject,
      project_id: input.projectId,
      llm_model_id: input.llmModelId,
      tool_config: input.toolConfig ? toolConfigJson(input.toolConfig) : null,
      thinking_enabled: input.thinkingEnabled,
      auto_mode: input.autoMode ?? false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // The chat's own key, wrapped for its owner (chat-keys.ts): every row
  // the chat will hold is sealed under it. In a project, also under the
  // project's key, so every member of the project opens it.
  const chat = { id: inserted.id, ownerSubject: input.ownerSubject };
  await createKey(db, 'chat', chat);
  if (input.projectId) await wrapKeyUnderProject(db, chat, input.projectId);
  return inserted.id;
}

export interface ChatPatch {
  title?: string | null;
  llmModelId?: string | null;
  toolConfig?: ChatToolConfig | null;
  thinkingEnabled?: boolean;
  autoMode?: boolean;
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
      ...(patch.autoMode !== undefined ? { auto_mode: patch.autoMode } : {}),
      ...(patch.archived !== undefined
        ? { archived_at: patch.archived ? sql<Date>`NOW()` : null }
        : {}),
      updated_at: sql<Date>`NOW()`,
    })
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
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', chatId)
    .executeTakeFirst();
  const moved = Number(result.numUpdatedRows) > 0;
  // Into a project: the project's members open the chat through its key.
  // (Out of one: the old wrapping stays inert — the project's access rules
  // no longer resolve the chat, so nobody reaches it that way.)
  if (moved && projectId) {
    await wrapKeyUnderProject(db, { id: chatId, tenantId, ownerSubject }, projectId);
  }
  return moved;
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
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', chatId)
    .executeTakeFirst();
  const deleted = Number(result.numDeletedRows) > 0;
  if (deleted) {
    await db
      .deleteFrom('resource_access_grants')
      .where('resource_kind', '=', 'chat')
      .where('resource_id', '=', chatId)
      .execute();
    await deleteKey(db, 'chat', tenantId, chatId);
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
