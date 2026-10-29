import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { ACTIVE, reindexRunFromRow, RESUMABLE } from './record';
import type { KnowledgeReindexRunStore } from './types';

export function memoryKnowledgeReindexRuns(tables: MemoryTables): KnowledgeReindexRunStore {
  return {
    async listRecent(limit) {
      const rows = orderBy(
        tables.select('knowledge_reindex_runs'),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      return page(rows, limit).map(reindexRunFromRow);
    },
    async find(id, kind) {
      const wanted = id;
      const row = tables.first('knowledge_reindex_runs', (r) => r.id === wanted && r.kind === kind);
      return row ? reindexRunFromRow(row) : null;
    },
    async findActive(kind) {
      const rows = tables.select(
        'knowledge_reindex_runs',
        (r) => r.kind === kind && ACTIVE.includes(r.status)
      );
      const row = orderBy(rows, [(r) => r.created_at], [(r) => r.id])[0];
      return row ? reindexRunFromRow(row) : null;
    },
    async create(run) {
      tables.insert('knowledge_reindex_runs', {
        id: run.id,
        kind: run.kind,
        requested_by: run.requestedBy,
        status: 'queued',
        cursor: null,
        processed: 0,
        skipped: 0,
        failed: 0,
        last_error: null,
        started_at: null,
        finished_at: null,
        created_at: new Date(),
      });
    },
    async pause(id, kind) {
      const wanted = id;
      return tables.update(
        'knowledge_reindex_runs',
        (r) => r.id === wanted && r.kind === kind && ACTIVE.includes(r.status),
        { status: 'paused' }
      ).length;
    },
    async resume(id) {
      const wanted = id;
      return tables.update(
        'knowledge_reindex_runs',
        (r) => r.id === wanted && RESUMABLE.includes(r.status),
        { status: 'queued', last_error: null, finished_at: null }
      ).length;
    },
    async markFailed(id, error) {
      const wanted = id;
      tables.update('knowledge_reindex_runs', (r) => r.id === wanted, {
        status: 'failed',
        last_error: error,
      });
    },
    async get(id) {
      const wanted = id;
      const row = tables.first('knowledge_reindex_runs', (r) => r.id === wanted);
      return row ? reindexRunFromRow(row) : null;
    },
    async markRunning(id) {
      const wanted = id;
      tables.update('knowledge_reindex_runs', (r) => r.id === wanted, {
        status: 'running',
        started_at: new Date(),
      });
    },
    async failRun(id, error) {
      const wanted = id;
      tables.update('knowledge_reindex_runs', (r) => r.id === wanted, {
        status: 'failed',
        last_error: error,
        finished_at: new Date(),
      });
    },
    async recordProgress(id, progress) {
      const wanted = id;
      tables.update(
        'knowledge_reindex_runs',
        (r) => r.id === wanted,
        (r) => ({
          processed: r.processed + progress.processed,
          skipped: r.skipped + progress.skipped,
          failed: r.failed + progress.failed,
          cursor: progress.cursor,
          ...(progress.done ? { status: 'done', finished_at: new Date() } : {}),
        })
      );
    },
  };
}
