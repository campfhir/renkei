import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import {
  newProjectValues,
  projectFromRow,
  projectMemoryFromRow,
  projectPatchValues,
} from './record';
import type { ChatProjectStore } from './types';

export function postgresChatProjects(db: () => Kysely<DB>): ChatProjectStore {
  return {
    async get(projectId) {
      const row = await db()
        .selectFrom('chat_projects')
        .selectAll()
        .where('id', '=', projectId)
        .executeTakeFirst();
      return row ? projectFromRow(row) : null;
    },
    async listOwned(ownerSubject) {
      const rows = await db()
        .selectFrom('chat_projects')
        .selectAll()
        .where('owner_subject', '=', ownerSubject)
        .orderBy('updated_at', 'desc')
        .orderBy('id')
        .execute();
      return rows.map(projectFromRow);
    },
    async listByIds(projectIds, options = {}) {
      if (projectIds.length === 0) return [];
      let query = db().selectFrom('chat_projects').selectAll().where('id', 'in', projectIds);
      query =
        options.orderBy === 'name'
          ? query.orderBy('name', 'asc')
          : query.orderBy('updated_at', 'desc');
      const rows = await query.orderBy('id').execute();
      return rows.map(projectFromRow);
    },
    async withGrantCounts(projectIds) {
      if (projectIds.length === 0) return [];
      const rows = await db()
        .selectFrom('chat_projects as p')
        .leftJoin('resource_access_grants as g', (join) =>
          join
            .onRef('g.resource_id', '=', 'p.id')
            .on('g.resource_kind', '=', 'chat_project')
            .on((eb) =>
              eb.or([eb('g.expires_at', 'is', null), eb('g.expires_at', '>', new Date())])
            )
        )
        .select((eb) => ['p.id', 'p.name', 'p.kind', eb.fn.count<string>('g.id').as('grants')])
        .where('p.id', 'in', projectIds)
        .groupBy(['p.id', 'p.name', 'p.kind'])
        .orderBy('p.id')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        grants: Number(row.grants),
      }));
    },
    async create(project) {
      const inserted = await db()
        .insertInto('chat_projects')
        .values(newProjectValues(project))
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async update(projectId, patch) {
      const result = await db()
        .updateTable('chat_projects')
        .set({ ...projectPatchValues(patch), updated_at: sql<Date>`NOW()` })
        .where('id', '=', projectId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async delete(ownerSubject, projectId) {
      const result = await db()
        .deleteFrom('chat_projects')
        .where('owner_subject', '=', ownerSubject)
        .where('id', '=', projectId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
    async listMemory(projectId, limit) {
      const rows = await db()
        .selectFrom('chat_project_memories')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(projectMemoryFromRow);
    },
    async appendMemory(entry) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const inserted = await trx
            .insertInto('chat_project_memories')
            .values({
              project_id: entry.projectId,
              kind: 'entry',
              content: entry.content,
              author_subject: entry.authorSubject,
              chat_id: entry.chatId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await sql`
            DELETE FROM chat_project_memories
             WHERE project_id = ${entry.projectId} AND kind = 'entry'
               AND id IN (
                 SELECT id FROM chat_project_memories
                  WHERE project_id = ${entry.projectId} AND kind = 'entry'
                  ORDER BY created_at DESC, id OFFSET ${entry.keep}
               )
          `.execute(trx);
          return inserted.id;
        });
    },
    async forgetMemory(projectId, target) {
      if (target.kind === 'entries' && target.ids.length === 0) return 0;
      let query = db().deleteFrom('chat_project_memories').where('project_id', '=', projectId);
      if (target.kind === 'entries') query = query.where('id', 'in', target.ids);
      const result = await query.executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
