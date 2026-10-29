import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables, type Row } from '../../memory/tables';
import { chatFromRow, chatPatchValues, newChatValues } from './record';
import type { ChatStore } from './types';

type Chat = Row<'chats'>;

const newestFirst = (rows: Chat[]) => orderBy(rows, [(r) => r.updated_at, 'desc'], [(r) => r.id]);

/** What a chat's delete takes with it: its thread, files and side rows. */
function deleteChatRows(tables: MemoryTables, chatIds: Set<string>): void {
  const ofChat = (r: { chat_id: string }) => chatIds.has(r.chat_id);
  for (const table of [
    'chat_drafts',
    'chat_messages',
    'chat_presence',
    'chat_queued_sends',
    'chat_subagent_runs',
    'chat_summaries',
    'chat_turns',
    'chat_widget_decisions',
  ] as const) {
    tables.delete(table, ofChat);
  }
  tables.delete('artifacts', (r) => r.chat_id !== null && chatIds.has(r.chat_id));
  for (const table of [
    'chat_project_memories',
    'chat_user_memories',
    'pr_subscriptions',
  ] as const) {
    tables.update(table, (r) => r.chat_id !== null && chatIds.has(r.chat_id), { chat_id: null });
  }
}

const toolConfigOf = (value: unknown) =>
  value === null || value === undefined ? null : toJson(value);

export function memoryChats(tables: MemoryTables): ChatStore {
  const ownChat = (ownerSubject: string, id: string) => {
    const wanted = id;
    return (r: Chat) => r.owner_subject === ownerSubject && r.id === wanted;
  };

  return {
    async get(id) {
      const wanted = id;
      const row = tables.first('chats', (r) => r.id === wanted);
      return row ? chatFromRow(row) : null;
    },
    async listOwned(ownerSubject, options) {
      const rows = tables.select(
        'chats',
        (r) =>
          r.owner_subject === ownerSubject &&
          (options.includeArchived || r.archived_at === null) &&
          (!options.since || r.updated_at.getTime() >= options.since.getTime()) &&
          (!options.before || r.updated_at.getTime() < options.before.getTime())
      );
      return page(newestFirst(rows), options.limit).map(chatFromRow);
    },
    async listOwnedInProject(ownerSubject, projectId, limit) {
      const project = projectId;
      const rows = tables.select(
        'chats',
        (r) =>
          r.owner_subject === ownerSubject && r.project_id === project && r.archived_at === null
      );
      return page(newestFirst(rows), limit).map(chatFromRow);
    },
    async hasOwnedBefore(ownerSubject, before) {
      return (
        tables.first(
          'chats',
          (r) =>
            r.owner_subject === ownerSubject &&
            r.updated_at.getTime() < before.getTime() &&
            r.last_message_at !== null
        ) !== undefined
      );
    },
    async listInProjects(projectIds, options) {
      if (projectIds.length === 0) return [];
      const ids = new Set(projectIds.map((id) => id));
      const rows = tables.select(
        'chats',
        (r) =>
          r.project_id !== null &&
          ids.has(r.project_id) &&
          r.archived_at === null &&
          (options.excludeOwner === null || r.owner_subject !== options.excludeOwner) &&
          (!options.since || r.updated_at.getTime() >= options.since.getTime())
      );
      return page(newestFirst(rows), options.limit).map(chatFromRow);
    },
    async listByIds(chatIds) {
      if (chatIds.length === 0) return [];
      const ids = new Set(chatIds);
      return newestFirst(tables.select('chats', (r) => ids.has(r.id))).map(chatFromRow);
    },
    async create(chat) {
      const now = new Date();
      return tables.insert('chats', {
        ...newChatValues(chat),
        id: globalThis.crypto.randomUUID(),
        tool_config: toolConfigOf(chat.toolConfig),
        title: null,
        archived_at: null,
        last_message_at: null,
        auto_title_asked: false,
        request_overhead_tokens: null,
        workspace_id: null,
        created_at: now,
        updated_at: now,
      }).id;
    },
    async update(ownerSubject, id, patch) {
      const now = new Date();
      return (
        tables.update('chats', ownChat(ownerSubject, id), {
          ...chatPatchValues(patch),
          ...(patch.toolConfig !== undefined
            ? { tool_config: toolConfigOf(patch.toolConfig) }
            : {}),
          ...(patch.archived !== undefined ? { archived_at: patch.archived ? now : null } : {}),
          updated_at: now,
        }).length > 0
      );
    },
    async move(ownerSubject, id, projectId) {
      return (
        tables.update('chats', ownChat(ownerSubject, id), {
          project_id: projectId,
          updated_at: new Date(),
        }).length > 0
      );
    },
    async delete(ownerSubject, id) {
      const deleted = tables.delete('chats', ownChat(ownerSubject, id));
      deleteChatRows(tables, new Set(deleted.map((row) => row.id)));
      return deleted.length > 0;
    },
    async touch(id, input) {
      const wanted = id;
      const now = new Date();
      tables.update(
        'chats',
        (r) => r.id === wanted,
        (r) => ({
          last_message_at: now,
          updated_at: now,
          ...(input.titleIfMissing !== undefined ? { title: r.title ?? input.titleIfMissing } : {}),
          ...(input.llmModelId !== undefined ? { llm_model_id: input.llmModelId } : {}),
        })
      );
    },
    async claimAutoTitle(id) {
      const wanted = id;
      const [row] = tables.update('chats', (r) => r.id === wanted && !r.auto_title_asked, {
        auto_title_asked: true,
      });
      return row ? { placeholder: row.title } : null;
    },
    async renameIfTitledAs(id, expected, title) {
      const wanted = id;
      return (
        tables.update(
          'chats',
          (r) => r.id === wanted && (expected === null ? r.title === null : r.title === expected),
          { title, updated_at: new Date() }
        ).length > 0
      );
    },
    async getRequestOverhead(id) {
      const wanted = id;
      return tables.first('chats', (r) => r.id === wanted)?.request_overhead_tokens ?? null;
    },
    async setRequestOverhead(id, tokens) {
      const wanted = id;
      tables.update('chats', (r) => r.id === wanted, { request_overhead_tokens: tokens });
    },
    async setWorkspace(id, workspaceId) {
      const wanted = id;
      tables.update('chats', (r) => r.id === wanted, { workspace_id: workspaceId });
    },
    async deleteAbandoned(createdBefore) {
      const holding = new Set([
        ...tables.select('chat_messages').map((m) => m.chat_id),
        ...tables.select('artifacts').flatMap((a) => (a.chat_id === null ? [] : [a.chat_id])),
      ]);
      const deleted = tables
        .delete(
          'chats',
          (r) =>
            r.last_message_at === null &&
            r.created_at.getTime() < createdBefore.getTime() &&
            !holding.has(r.id)
        )
        .map((row) => row.id)
        .sort();
      deleteChatRows(tables, new Set(deleted));
      return deleted;
    },
    async archiveIdle(ownerSubject, updatedBefore) {
      const running = new Set(
        tables.select('chat_turns', (t) => t.status === 'running').map((t) => t.chat_id)
      );
      return tables
        .update(
          'chats',
          (r) =>
            r.owner_subject === ownerSubject &&
            r.archived_at === null &&
            r.updated_at.getTime() < updatedBefore.getTime() &&
            !running.has(r.id),
          { archived_at: new Date() }
        )
        .map((row) => row.id)
        .sort();
    },
    async listIdsUpdatedBefore(before, limit) {
      return page(
        orderBy(
          tables.select('chats', (r) => r.updated_at.getTime() < before.getTime()),
          [(r) => r.updated_at],
          [(r) => r.id]
        ),
        limit
      ).map((row) => row.id);
    },
    async deleteMany(chatIds) {
      if (chatIds.length === 0) return 0;
      const ids = new Set(chatIds);
      const deleted = tables.delete('chats', (r) => ids.has(r.id));
      deleteChatRows(tables, new Set(deleted.map((row) => row.id)));
      return deleted.length;
    },
  };
}
