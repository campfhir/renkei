import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import {
  BATCH_COLUMNS,
  ITEM_COLUMNS,
  TERMINAL_STATUSES,
  batchFromRow,
  batchValues,
  itemFromRow,
  itemValues,
  json,
} from './record';
import type { BatchJobStore } from './types';

export function postgresBatchJobs(db: () => Kysely<DB>): BatchJobStore {
  return {
    async create(batch) {
      const row = await db()
        .insertInto('batch_jobs')
        .values(batchValues(batch))
        .returning(BATCH_COLUMNS)
        .executeTakeFirstOrThrow();
      return batchFromRow(row);
    },
    async get(batchId) {
      const row = await db()
        .selectFrom('batch_jobs')
        .select(BATCH_COLUMNS)
        .where('id', '=', batchId)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async list(subject, options = {}) {
      let query = db()
        .selectFrom('batch_jobs')
        .select(BATCH_COLUMNS)
        .where('subject', '=', subject)
        .orderBy('created_at', 'desc')
        .orderBy('id');
      if (options.status) query = query.where('status', '=', options.status);
      if (options.scheduleId) query = query.where('schedule_id', '=', options.scheduleId);
      if (options.limit) query = query.limit(options.limit);
      return (await query.execute()).map(batchFromRow);
    },
    async beginDiscovery(batchId) {
      const row = await db()
        .updateTable('batch_jobs')
        .set({ status: 'discovering', started_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', batchId)
        .where('status', '=', 'queued')
        .returning(BATCH_COLUMNS)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async fail(batchId, message) {
      const row = await db()
        .updateTable('batch_jobs')
        .set({
          status: 'failed',
          last_error: message,
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', batchId)
        .where('status', 'not in', TERMINAL_STATUSES)
        .returning(BATCH_COLUMNS)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async completeEmpty(batchId, skipped) {
      const row = await db()
        .updateTable('batch_jobs')
        .set({
          status: 'succeeded',
          total: skipped,
          skipped: sql`skipped + ${skipped}`,
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', batchId)
        .where('status', 'not in', TERMINAL_STATUSES)
        .returning(BATCH_COLUMNS)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async activate(batchId, total, skipped) {
      const row = await db()
        .updateTable('batch_jobs')
        .set({
          status: 'running',
          total,
          skipped: sql`skipped + ${skipped}`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', batchId)
        .returning(BATCH_COLUMNS)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async addCounts(batchId, counts) {
      const row = await db()
        .updateTable('batch_jobs')
        .set({
          succeeded: sql`succeeded + ${counts.succeeded}`,
          failed: sql`failed + ${counts.failed}`,
          skipped: sql`skipped + ${counts.skipped}`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', batchId)
        .returning(BATCH_COLUMNS)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async finishRunning(batchId, status) {
      const row = await db()
        .updateTable('batch_jobs')
        .set({ status, finished_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', batchId)
        .where('status', '=', 'running')
        .returning(BATCH_COLUMNS)
        .executeTakeFirst();
      return row ? batchFromRow(row) : undefined;
    },
    async insertItem(batchId, item) {
      const row = await db()
        .insertInto('batch_job_items')
        .values(itemValues(batchId, item))
        .returning(ITEM_COLUMNS)
        .executeTakeFirstOrThrow();
      return itemFromRow(row);
    },
    async getItem(itemId) {
      const row = await db()
        .selectFrom('batch_job_items')
        .select(ITEM_COLUMNS)
        .where('id', '=', itemId)
        .executeTakeFirst();
      return row ? itemFromRow(row) : undefined;
    },
    async claimItem(itemId) {
      const row = await db()
        .updateTable('batch_job_items')
        .set({ status: 'processing', updated_at: sql`NOW()` })
        .where('id', '=', itemId)
        .where('status', '=', 'pending')
        .returning(ITEM_COLUMNS)
        .executeTakeFirst();
      return row ? itemFromRow(row) : undefined;
    },
    async setItemOutcome(itemId, outcome) {
      await db()
        .updateTable('batch_job_items')
        .set({
          status: outcome.status,
          result: json(outcome.result),
          error: outcome.error,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', itemId)
        .execute();
    },
    async listItems(batchId, options = {}) {
      let query = db()
        .selectFrom('batch_job_items')
        .select(ITEM_COLUMNS)
        .where('batch_id', '=', batchId);
      if (options.status) query = query.where('status', '=', options.status);
      query = query.orderBy('created_at', 'asc').orderBy('id');
      if (options.limit) query = query.limit(options.limit);
      return (await query.execute()).map(itemFromRow);
    },
    async findProcessedByPath(shareId, paths) {
      if (paths.length === 0) return [];
      const rows = await db()
        .selectFrom('batch_processed_files')
        .select(['content_hash', 'path', 'size', 'modified_at'])
        .where('share_id', '=', shareId)
        .where('path', 'in', [...paths])
        .orderBy('path')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        contentHash: row.content_hash,
        path: row.path,
        size: row.size,
        modifiedAt: row.modified_at ? new Date(row.modified_at) : null,
      }));
    },
    async findProcessedHashes(shareId, hashes) {
      if (hashes.length === 0) return [];
      const rows = await db()
        .selectFrom('batch_processed_files')
        .select('content_hash')
        .where('share_id', '=', shareId)
        .where('content_hash', 'in', [...hashes])
        .orderBy('content_hash')
        .execute();
      return rows.map((row) => row.content_hash);
    },
    async recordProcessedFiles(shareId, batchId, files) {
      if (files.length === 0) return;
      await db()
        .insertInto('batch_processed_files')
        .values(
          files.map((file) => ({
            id: globalThis.crypto.randomUUID(),
            share_id: shareId,
            content_hash: file.contentHash,
            path: file.path,
            size: file.size,
            modified_at: file.modifiedAt,
            batch_id: batchId,
            document_key: file.documentKey ?? null,
          }))
        )
        .onConflict((oc) =>
          oc.columns(['share_id', 'content_hash']).doUpdateSet({
            path: sql`excluded.path`,
            size: sql`excluded.size`,
            modified_at: sql`excluded.modified_at`,
            batch_id: sql`excluded.batch_id`,
            document_key: sql`excluded.document_key`,
            processed_at: sql`NOW()`,
          })
        )
        .execute();
    },
  };
}
