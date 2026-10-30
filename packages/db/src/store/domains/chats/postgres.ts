import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { chatFromRow, chatPatchValues, newChatValues } from './record';
import type { ChatStore } from './types';

export function postgresChats(db: () => Kysely<DB>): ChatStore {
  return {
    async get(chatId) {
      const row = await db()
        .selectFrom('chats')
        .selectAll()
        .where('id', '=', chatId)
        .executeTakeFirst();
      return row ? chatFromRow(row) : null;
    },
    async listOwned(ownerSubject, options) {
      let query = db().selectFrom('chats').selectAll().where('owner_subject', '=', ownerSubject);
      if (!options.includeArchived) query = query.where('archived_at', 'is', null);
      if (options.since) query = query.where('updated_at', '>=', options.since);
      if (options.before) query = query.where('updated_at', '<', options.before);
      const rows = await query
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .limit(options.limit)
        .execute();
      return rows.map(chatFromRow);
    },
    async listOwnedInProject(ownerSubject, projectId, limit) {
      const rows = await db()
        .selectFrom('chats')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('owner_subject', '=', ownerSubject)
        .where('archived_at', 'is', null)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(chatFromRow);
    },
    async hasOwnedBefore(ownerSubject, before) {
      const row = await db()
        .selectFrom('chats')
        .select('id')
        .where('owner_subject', '=', ownerSubject)
        .where('updated_at', '<', before)
        .where('last_message_at', 'is not', null)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },
    async listInProjects(projectIds, options) {
      if (projectIds.length === 0) return [];
      let query = db()
        .selectFrom('chats')
        .selectAll()
        .where('project_id', 'in', projectIds)
        .where('archived_at', 'is', null);
      if (options.excludeOwner) query = query.where('owner_subject', '!=', options.excludeOwner);
      if (options.since) query = query.where('updated_at', '>=', options.since);
      const rows = await query
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .limit(options.limit)
        .execute();
      return rows.map(chatFromRow);
    },
    async listByIds(chatIds) {
      if (chatIds.length === 0) return [];
      const rows = await db()
        .selectFrom('chats')
        .selectAll()
        .where('id', 'in', chatIds)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .execute();
      return rows.map(chatFromRow);
    },
    async create(chat) {
      const inserted = await db()
        .insertInto('chats')
        .values(newChatValues(chat))
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async update(ownerSubject, chatId, patch) {
      const result = await db()
        .updateTable('chats')
        .set({
          ...chatPatchValues(patch),
          ...(patch.archived !== undefined
            ? { archived_at: patch.archived ? sql<Date>`NOW()` : null }
            : {}),
          updated_at: sql<Date>`NOW()`,
        })
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', chatId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async move(ownerSubject, chatId, projectId) {
      const result = await db()
        .updateTable('chats')
        .set({ project_id: projectId, updated_at: sql<Date>`NOW()` })
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', chatId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async delete(ownerSubject, chatId) {
      const result = await db()
        .deleteFrom('chats')
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', chatId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async touch(chatId, input) {
      await db()
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
    },
    async claimAutoTitle(chatId) {
      const row = await db()
        .updateTable('chats')
        .set({ auto_title_asked: true })
        .where('id', '=', chatId)
        .where('auto_title_asked', '=', false)
        .returning('title')
        .executeTakeFirst();
      return row ? { placeholder: row.title } : null;
    },
    async renameIfTitledAs(chatId, expected, title) {
      const result = await db()
        .updateTable('chats')
        .set({ title, updated_at: sql<Date>`NOW()` })
        .where('id', '=', chatId)
        .where((eb) => (expected === null ? eb('title', 'is', null) : eb('title', '=', expected)))
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async getRequestOverhead(chatId) {
      const row = await db()
        .selectFrom('chats')
        .select('request_overhead_tokens')
        .where('id', '=', chatId)
        .executeTakeFirst();
      return row?.request_overhead_tokens ?? null;
    },
    async setRequestOverhead(chatId, tokens) {
      await db()
        .updateTable('chats')
        .set({ request_overhead_tokens: tokens })
        .where('id', '=', chatId)
        .execute();
    },
    async setWorkspace(chatId, workspaceId) {
      await db()
        .updateTable('chats')
        .set({ workspace_id: workspaceId })
        .where('id', '=', chatId)
        .execute();
    },
    async deleteAbandoned(createdBefore) {
      const deleted = await sql<{ id: string }>`
        DELETE FROM chats c
         WHERE c.last_message_at IS NULL
           AND c.created_at < ${createdBefore}
           AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.chat_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.chat_id = c.id)
        RETURNING c.id
      `.execute(db());
      return deleted.rows.map((row) => row.id).sort();
    },
    async archiveIdle(ownerSubject, updatedBefore) {
      const archived = await sql<{ id: string }>`
        UPDATE chats c
           SET archived_at = NOW()
         WHERE c.owner_subject = ${ownerSubject}
           AND c.archived_at IS NULL
           AND c.updated_at < ${updatedBefore}
           AND NOT EXISTS (
             SELECT 1 FROM chat_turns t WHERE t.chat_id = c.id AND t.status = 'running'
           )
         RETURNING c.id
      `.execute(db());
      return archived.rows.map((row) => row.id).sort();
    },
    async listTemporaryIdleIds(before, limit) {
      const rows = await sql<{ id: string }>`
        SELECT c.id FROM chats c
         WHERE c.temporary
           AND c.updated_at < ${before}
           AND NOT EXISTS (
             SELECT 1 FROM chat_turns t WHERE t.chat_id = c.id AND t.status = 'running'
           )
         ORDER BY c.updated_at, c.id
         LIMIT ${limit}
      `.execute(db());
      return rows.rows.map((row) => row.id);
    },
    async listIdsUpdatedBefore(before, limit) {
      const rows = await db()
        .selectFrom('chats')
        .select('id')
        .where('updated_at', '<', before)
        .orderBy('updated_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => row.id);
    },
    async deleteMany(chatIds) {
      if (chatIds.length === 0) return 0;
      const result = await db()
        .deleteFrom('chats')
        .where('id', 'in', [...chatIds])
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}
