import { orderBy, page, sameValue } from '../../memory/order';
import { toJson, type MemoryTables, type Row, type RowPatch } from '../../memory/tables';
import { TERMINAL_STATUSES, batchFromRow, batchValues, itemFromRow, itemValues } from './record';
import type { BatchJobStore } from './types';

export function memoryBatchJobs(tables: MemoryTables): BatchJobStore {
  /** UPDATE batch_jobs … WHERE id = $1 [AND guard] RETURNING …, for one row. */
  function updateBatch(
    batchId: string,
    guard: (status: string) => boolean,
    patch: (row: Row<'batch_jobs'>) => RowPatch<'batch_jobs'>
  ) {
    const key = batchId;
    const [row] = tables.update(
      'batch_jobs',
      (r) => sameValue(r.id, key) && guard(r.status),
      (r) => ({ ...patch(r), updated_at: new Date() })
    );
    return row ? batchFromRow(row) : undefined;
  }

  const notTerminal = (status: string) => !TERMINAL_STATUSES.includes(status);

  return {
    async create(batch) {
      const now = new Date();
      return batchFromRow(
        tables.insert('batch_jobs', {
          ...batchValues(batch),
          config: toJson(batch.config ?? {}),
          status: 'queued',
          total: null,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          last_error: null,
          started_at: null,
          finished_at: null,
          created_at: now,
          updated_at: now,
        })
      );
    },
    async get(batchId) {
      const key = batchId;
      const row = tables.first('batch_jobs', (r) => sameValue(r.id, key));
      return row ? batchFromRow(row) : undefined;
    },
    async list(subject, options = {}) {
      const scheduleKey = options.scheduleId ? options.scheduleId : undefined;
      const rows = tables.select(
        'batch_jobs',
        (r) =>
          r.subject === subject &&
          (!options.status || r.status === options.status) &&
          (scheduleKey === undefined || sameValue(r.schedule_id, scheduleKey))
      );
      return page(
        orderBy(rows, [(r) => r.created_at, 'desc'], [(r) => r.id]),
        options.limit || undefined
      ).map(batchFromRow);
    },
    async beginDiscovery(batchId) {
      const now = new Date();
      return updateBatch(
        batchId,
        (status) => status === 'queued',
        () => ({ status: 'discovering', started_at: now })
      );
    },
    async fail(batchId, message) {
      return updateBatch(batchId, notTerminal, () => ({
        status: 'failed',
        last_error: message,
        finished_at: new Date(),
      }));
    },
    async completeEmpty(batchId, skipped) {
      return updateBatch(batchId, notTerminal, (r) => ({
        status: 'succeeded',
        total: skipped,
        skipped: r.skipped + skipped,
        finished_at: new Date(),
      }));
    },
    async activate(batchId, total, skipped) {
      return updateBatch(
        batchId,
        () => true,
        (r) => ({ status: 'running', total, skipped: r.skipped + skipped })
      );
    },
    async addCounts(batchId, counts) {
      const key = batchId;
      const [row] = tables.update(
        'batch_jobs',
        (r) => sameValue(r.id, key),
        (r) => ({
          succeeded: r.succeeded + counts.succeeded,
          failed: r.failed + counts.failed,
          skipped: r.skipped + counts.skipped,
          updated_at: new Date(),
        })
      );
      return row ? batchFromRow(row) : undefined;
    },
    async finishRunning(batchId, status) {
      return updateBatch(
        batchId,
        (current) => current === 'running',
        () => ({ status, finished_at: new Date() })
      );
    },
    async insertItem(batchId, item) {
      const now = new Date();
      return itemFromRow(
        tables.insert('batch_job_items', {
          ...itemValues(batchId, item),
          payload: toJson(item.payload ?? {}),
          status: item.status || 'pending',
          result: item.result === undefined ? null : toJson(item.result),
          error: null,
          created_at: now,
          updated_at: now,
        })
      );
    },
    async getItem(itemId) {
      const key = itemId;
      const row = tables.first('batch_job_items', (r) => sameValue(r.id, key));
      return row ? itemFromRow(row) : undefined;
    },
    async claimItem(itemId) {
      const key = itemId;
      const [row] = tables.update(
        'batch_job_items',
        (r) => sameValue(r.id, key) && r.status === 'pending',
        { status: 'processing', updated_at: new Date() }
      );
      return row ? itemFromRow(row) : undefined;
    },
    async setItemOutcome(itemId, outcome) {
      const key = itemId;
      tables.update('batch_job_items', (r) => sameValue(r.id, key), {
        status: outcome.status,
        result: toJson(outcome.result),
        error: outcome.error,
        updated_at: new Date(),
      });
    },
    async listItems(batchId, options = {}) {
      const key = batchId;
      const rows = tables.select(
        'batch_job_items',
        (r) => sameValue(r.batch_id, key) && (!options.status || r.status === options.status)
      );
      return page(
        orderBy(rows, [(r) => r.created_at], [(r) => r.id]),
        options.limit || undefined
      ).map(itemFromRow);
    },
    async findProcessedByPath(shareId, paths) {
      if (paths.length === 0) return [];
      const share = shareId;
      const wanted = new Set(paths);
      const rows = tables.select(
        'batch_processed_files',
        (r) => r.share_id === share && wanted.has(r.path)
      );
      return orderBy(rows, [(r) => r.path], [(r) => r.id]).map((row) => ({
        contentHash: row.content_hash,
        path: row.path,
        size: row.size,
        modifiedAt: row.modified_at ? new Date(row.modified_at) : null,
      }));
    },
    async findProcessedHashes(shareId, hashes) {
      if (hashes.length === 0) return [];
      const share = shareId;
      const wanted = new Set(hashes);
      const rows = tables.select(
        'batch_processed_files',
        (r) => r.share_id === share && wanted.has(r.content_hash)
      );
      return orderBy(rows, [(r) => r.content_hash]).map((row) => row.content_hash);
    },
    async recordProcessedFiles(shareId, batchId, files) {
      for (const file of files) {
        const values = {
          path: file.path,
          size: file.size,
          modified_at: file.modifiedAt,
          batch_id: batchId,
          document_key: file.documentKey ?? null,
        };
        tables.upsert(
          'batch_processed_files',
          {
            id: globalThis.crypto.randomUUID(),
            share_id: shareId,
            content_hash: file.contentHash,
            ...values,
            processed_at: new Date(),
          },
          ['share_id', 'content_hash'],
          { ...values, processed_at: new Date() }
        );
      }
    },
  };
}
