import { toJson, type MemoryTables } from '../../memory/tables';
import { mailBulkJobFromRow, mailBulkJobValues } from './postgres';
import type { MailBulkJobStore } from './types';
import { orderBy, page } from '../../memory/order';

export function memoryMailBulkJobs(tables: MemoryTables): MailBulkJobStore {
  return {
    async create(job) {
      const now = new Date();
      tables.insert('mail_bulk_jobs', {
        ...mailBulkJobValues(job),
        params: toJson(job.params),
        selection: toJson(job.selection),
        status: 'queued',
        total: null,
        succeeded: 0,
        failed: 0,
        failures: [],
        last_error: null,
        started_at: null,
        finished_at: null,
        created_at: now,
        updated_at: now,
      });
    },
    async markFailed(id, error) {
      const key = id;
      tables.update('mail_bulk_jobs', (r) => r.id === key, { status: 'failed', last_error: error });
    },
    async getOwned(id, subject) {
      const key = id;
      const row = tables.first('mail_bulk_jobs', (r) => r.id === key && r.subject === subject);
      return row ? mailBulkJobFromRow(row) : null;
    },
    async get(id) {
      const key = id;
      const row = tables.first('mail_bulk_jobs', (r) => r.id === key);
      return row ? mailBulkJobFromRow(row) : null;
    },
    async markRunning(id) {
      const key = id;
      const now = new Date();
      tables.update('mail_bulk_jobs', (r) => r.id === key, {
        status: 'running',
        started_at: now,
        updated_at: now,
      });
    },
    async setTotal(id, total) {
      const key = id;
      tables.update('mail_bulk_jobs', (r) => r.id === key, { total, updated_at: new Date() });
    },
    async recordProgress(id, progress) {
      const key = id;
      tables.update('mail_bulk_jobs', (r) => r.id === key, {
        succeeded: progress.succeeded,
        failed: progress.failed,
        failures: toJson(progress.failures),
        updated_at: new Date(),
      });
    },
    async finish(id, outcome) {
      const key = id;
      const now = new Date();
      tables.update('mail_bulk_jobs', (r) => r.id === key, {
        status: outcome.status,
        ...(outcome.lastError !== undefined ? { last_error: outcome.lastError } : {}),
        finished_at: now,
        updated_at: now,
      });
    },
    async failStalled(minutes, error) {
      const now = new Date();
      const cutoff = now.getTime() - minutes * 60_000;
      return tables.update(
        'mail_bulk_jobs',
        (r) => r.status === 'running' && r.updated_at.getTime() < cutoff,
        { status: 'failed', last_error: error, finished_at: now, updated_at: now }
      ).length;
    },
    async pruneFinished(days, limit) {
      const cutoff = Date.now() - days * 24 * 60 * 60_000;
      const doomed = new Set(
        page(
          orderBy(
            tables.select(
              'mail_bulk_jobs',
              (r) =>
                ['succeeded', 'partial', 'failed'].includes(r.status) &&
                r.created_at.getTime() < cutoff
            ),
            [(r) => r.created_at],
            [(r) => r.id]
          ),
          limit
        ).map((r) => r.id)
      );
      return tables.delete('mail_bulk_jobs', (r) => doomed.has(r.id)).length;
    },
  };
}
