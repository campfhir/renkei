/**
 * Chats and their rows — the data layer under every chat surface, over
 * the data store's `chats` repository.
 *
 * Ownership is structural: a chat is written only under its owner's
 * subject, so someone else's chat resolves to "not found" from every
 * mutation. Reading is broader (access.ts decides who may view what);
 * this module only knows how to fetch and change rows.
 */

import { getDataStore, type ChatRecord } from '@renkei/db';
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
  /** The model's one automatic title has been attempted (chat-title-tools.ts). */
  autoTitleAsked: boolean;
  /** A code chat's worktree on the sandbox worker (lib/code/projects.ts); null until its first turn makes one. */
  workspaceId: string | null;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The sidebar's ceiling — beyond it, search narrows. */
export const CHAT_LIST_LIMIT = 200;

function rowOf(chat: ChatRecord): ChatRow {
  return { ...chat, toolConfig: parseToolConfig(chat.toolConfig) };
}

export async function getChatRow(chatId: string): Promise<ChatRow | null> {
  if (!isUuid(chatId)) return null;
  const chat = await getDataStore().chats.get(chatId);
  return chat ? rowOf(chat) : null;
}

export async function getChatForOwner(
  ownerSubject: string,
  chatId: string
): Promise<ChatRow | null> {
  const row = await getChatRow(chatId);
  return row && row.ownerSubject === ownerSubject ? row : null;
}

export async function listOwnedChats(
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
  const rows = await getDataStore().chats.listOwned(ownerSubject, {
    ...options,
    limit: options.limit ?? CHAT_LIST_LIMIT,
  });
  return rows.map(rowOf);
}

/** Whether the owner has a chat touched before `before` — the "load more" button's cue to appear. */
export async function hasOwnedChatBefore(ownerSubject: string, before: Date): Promise<boolean> {
  return getDataStore().chats.hasOwnedBefore(ownerSubject, before);
}

/** Chats sitting in these projects, other than the viewer's own. */
export async function listProjectChats(
  projectIds: string[],
  excludeOwner: string | null,
  options: { since?: Date } = {}
): Promise<ChatRow[]> {
  const ids = projectIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await getDataStore().chats.listInProjects(ids, {
    excludeOwner,
    ...options,
    limit: CHAT_LIST_LIMIT,
  });
  return rows.map(rowOf);
}

export async function listChatsById(chatIds: string[]): Promise<ChatRow[]> {
  const ids = chatIds.filter(isUuid);
  if (ids.length === 0) return [];
  return (await getDataStore().chats.listByIds(ids)).map(rowOf);
}

export async function createChat(input: {
  ownerSubject: string;
  projectId: string | null;
  llmModelId: string | null;
  toolConfig: ChatToolConfig | null;
  thinkingEnabled: boolean;
  /** See ChatRow.autoMode. Defaults to off — callers opt in. */
  autoMode?: boolean;
}): Promise<string> {
  const id = await getDataStore().chats.create({
    ownerSubject: input.ownerSubject,
    projectId: input.projectId,
    llmModelId: input.llmModelId,
    toolConfig: input.toolConfig ? toolConfigJson(input.toolConfig) : null,
    thinkingEnabled: input.thinkingEnabled,
    autoMode: input.autoMode ?? false,
  });
  // The chat's own key, wrapped for its owner (chat-keys.ts): every row
  // the chat will hold is sealed under it. In a project, also under the
  // project's key, so every member of the project opens it.
  const chat = { id, ownerSubject: input.ownerSubject };
  await createKey('chat', chat);
  if (input.projectId) await wrapKeyUnderProject(chat, input.projectId);
  return id;
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
  ownerSubject: string,
  chatId: string,
  patch: ChatPatch
): Promise<boolean> {
  if (!isUuid(chatId)) return false;
  const { toolConfig, ...rest } = patch;
  return getDataStore().chats.update(ownerSubject, chatId, {
    ...rest,
    ...(toolConfig !== undefined
      ? { toolConfig: toolConfig ? toolConfigJson(toolConfig) : null }
      : {}),
  });
}

/** Moving is only a project_id change; the chat keeps everything else. */
export async function moveChatToProject(
  ownerSubject: string,
  chatId: string,
  projectId: string | null
): Promise<boolean> {
  if (!isUuid(chatId)) return false;
  const moved = await getDataStore().chats.move(ownerSubject, chatId, projectId);
  // Into a project: the project's members open the chat through its key.
  // (Out of one: the old wrapping stays inert — the project's access rules
  // no longer resolve the chat, so nobody reaches it that way.)
  if (moved && projectId) {
    await wrapKeyUnderProject({ id: chatId, ownerSubject }, projectId);
  }
  return moved;
}

export async function deleteChat(ownerSubject: string, chatId: string): Promise<boolean> {
  if (!isUuid(chatId)) return false;
  const store = getDataStore();
  const deleted = await store.chats.delete(ownerSubject, chatId);
  if (deleted) {
    await store.resourceGrants.deleteForResource('chat', chatId);
    await deleteKey('chat', chatId);
  }
  return deleted;
}

/** Bumps activity; sets the title only while the chat has none. */
export async function touchChat(
  chatId: string,
  input: { titleIfMissing?: string; llmModelId?: string | null }
): Promise<void> {
  await getDataStore().chats.touch(chatId, input);
}

/**
 * Claims the chat's one automatic title (chat-title-tools.ts). Returns the
 * title as it stands — the placeholder the send wrote from the first prompt —
 * when this call is the one that claimed it, or null when it was already claimed.
 */
export async function claimAutoTitle(
  chatId: string
): Promise<{ placeholder: string | null } | null> {
  return getDataStore().chats.claimAutoTitle(chatId);
}

/**
 * Renames the chat only while its title is still `expected`, so a title the
 * person set by hand while the model was thinking is never overwritten.
 */
export async function renameChatIfTitledAs(
  chatId: string,
  expected: string | null,
  title: string
): Promise<boolean> {
  return getDataStore().chats.renameIfTitledAs(chatId, expected, title);
}
