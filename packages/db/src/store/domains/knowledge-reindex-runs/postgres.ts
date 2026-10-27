import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ACTIVE, reindexRunFromRow, RESUMABLE } from './record';
import type { KnowledgeReindexRunStore } from './types';

export function postgresKnowledgeReindexRuns(db: () => Kysely<DB>): KnowledgeReindexRunStore {
  return {
    async listRecent(limit) {
      const rows = await db()
        .selectFrom('knowledge_reindex_runs')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(reindexRunFromRow);
    },
    async find(id, kind) {
      const row = await db()
        .selectFrom('knowledge_reindex_runs')
        .selectAll()
        .where('id', '=', id)
        .where('kind', '=', kind)
        .executeTakeFirst();
      return row ? reindexRunFromRow(row) : null;
    },
    async findActive(kind) {
      const row = await db()
        .selectFrom('knowledge_reindex_runs')
        .selectAll()
        .where('kind', '=', kind)
        .where('status', 'in', ACTIVE)
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      return row ? reindexRunFromRow(row) : null;
    },
    async create(run) {
      await db()
        .insertInto('knowledge_reindex_runs')
        .values({ id: run.id, kind: run.kind, requested_by: run.requestedBy })
        .execute();
    },
    async pause(id, kind) {
      const result = await db()
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'paused' })
        .where('id', '=', id)
        .where('kind', '=', kind)
        .where('status', 'in', ACTIVE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async resume(id) {
      const result = await db()
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'queued', last_error: null, finished_at: null })
        .where('id', '=', id)
        .where('status', 'in', RESUMABLE)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async markFailed(id, error) {
      await db()
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'failed', last_error: error })
        .where('id', '=', id)
        .execute();
    },
    async get(id) {
      const row = await db()
        .selectFrom('knowledge_reindex_runs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? reindexRunFromRow(row) : null;
    },
    async markRunning(id) {
      await db()
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'running', started_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async failRun(id, error) {
      await db()
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'failed', last_error: error, finished_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async recordProgress(id, progress) {
      await db()
        .updateTable('knowledge_reindex_runs')
        .set({
          processed: sql`processed + ${progress.processed}`,
          skipped: sql`skipped + ${progress.skipped}`,
          failed: sql`failed + ${progress.failed}`,
          cursor: progress.cursor,
          ...(progress.done ? { status: 'done', finished_at: sql`NOW()` } : {}),
        })
        .where('id', '=', id)
        .execute();
    },
  };
}
