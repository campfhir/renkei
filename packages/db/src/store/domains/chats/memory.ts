import { orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { chatFromRow, chatPatchValues, newChatValues } from './record';
import type { ChatStore } from './types';

type Chat = Row<'chats'>;

const newestFirst = (rows: Chat[]) => orderBy(rows, [(r) => r.updated_at, 'desc'], [(r) => r.id]);

export function memoryChats(tables: MemoryTables): ChatStore {
  const chatId = (value: string) => tables.param('chats', 'id', value);
  const ownChat = (ownerSubject: string, id: string) => {
    const wanted = chatId(id);
    return (r: Chat) => r.owner_subject === ownerSubject && r.id === wanted;
  };

  return {
    async get(id) {
      const wanted = chatId(id);
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
      const project = tables.param('chats', 'project_id', projectId);
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
      const ids = new Set(projectIds.map((id) => tables.param('chats', 'project_id', id)));
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
      const ids = new Set(chatIds.map(chatId));
      return newestFirst(tables.select('chats', (r) => ids.has(r.id))).map(chatFromRow);
    },
    async create(chat) {
      return tables.insert('chats', newChatValues(chat)).id;
    },
    async update(ownerSubject, id, patch) {
      const now = new Date();
      return (
        tables.update('chats', ownChat(ownerSubject, id), {
          ...chatPatchValues(patch),
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
      return tables.delete('chats', ownChat(ownerSubject, id)).length > 0;
    },
    async touch(id, input) {
      const wanted = chatId(id);
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
      const wanted = chatId(id);
      const [row] = tables.update('chats', (r) => r.id === wanted && !r.auto_title_asked, {
        auto_title_asked: true,
      });
      return row ? { placeholder: row.title } : null;
    },
    async renameIfTitledAs(id, expected, title) {
      const wanted = chatId(id);
      return (
        tables.update(
          'chats',
          (r) => r.id === wanted && (expected === null ? r.title === null : r.title === expected),
          { title, updated_at: new Date() }
        ).length > 0
      );
    },
    async getRequestOverhead(id) {
      const wanted = chatId(id);
      return tables.first('chats', (r) => r.id === wanted)?.request_overhead_tokens ?? null;
    },
    async setRequestOverhead(id, tokens) {
      const wanted = chatId(id);
      tables.update('chats', (r) => r.id === wanted, { request_overhead_tokens: tokens });
    },
    async setWorkspace(id, workspaceId) {
      const wanted = chatId(id);
      tables.update('chats', (r) => r.id === wanted, { workspace_id: workspaceId });
    },
  };
}
