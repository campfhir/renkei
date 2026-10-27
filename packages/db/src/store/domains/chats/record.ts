import type { Selectable } from 'kysely';
import type { Chats } from '../../../db.types';
import type { ChatRecord, ChatRecordPatch, NewChat } from './types';

export function chatFromRow(row: Selectable<Chats>): ChatRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    projectId: row.project_id,
    title: row.title,
    llmModelId: row.llm_model_id,
    toolConfig: row.tool_config ?? null,
    thinkingEnabled: row.thinking_enabled,
    autoMode: row.auto_mode,
    autoTitleAsked: row.auto_title_asked,
    workspaceId: row.workspace_id,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
    archivedAt: row.archived_at ? new Date(row.archived_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function newChatValues(chat: NewChat) {
  return {
    owner_subject: chat.ownerSubject,
    project_id: chat.projectId,
    llm_model_id: chat.llmModelId,
    tool_config: jsonOrNull(chat.toolConfig),
    thinking_enabled: chat.thinkingEnabled,
    auto_mode: chat.autoMode,
  };
}

/** The columns a patch sets, apart from the timestamps (archived_at is the caller's). */
export function chatPatchValues(patch: ChatRecordPatch) {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.llmModelId !== undefined ? { llm_model_id: patch.llmModelId } : {}),
    ...(patch.toolConfig !== undefined ? { tool_config: jsonOrNull(patch.toolConfig) } : {}),
    ...(patch.thinkingEnabled !== undefined ? { thinking_enabled: patch.thinkingEnabled } : {}),
    ...(patch.autoMode !== undefined ? { auto_mode: patch.autoMode } : {}),
  };
}
