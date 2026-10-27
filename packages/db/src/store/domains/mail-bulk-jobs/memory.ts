import type { MemoryTables } from '../../memory/tables';
import { mailBulkJobFromRow, mailBulkJobValues } from './postgres';
import type { MailBulkJobStore } from './types';

export function memoryMailBulkJobs(tables: MemoryTables): MailBulkJobStore {
  const idOf = (id: string) => tables.param('mail_bulk_jobs', 'id', id);
  return {
    async create(job) {
      tables.insert('mail_bulk_jobs', mailBulkJobValues(job));
    },
    async markFailed(id, error) {
      const key = idOf(id);
      tables.update('mail_bulk_jobs', (r) => r.id === key, { status: 'failed', last_error: error });
    },
    async getOwned(id, subject) {
      const key = idOf(id);
      const row = tables.first('mail_bulk_jobs', (r) => r.id === key && r.subject === subject);
      return row ? mailBulkJobFromRow(row) : null;
    },
    async get(id) {
      const key = idOf(id);
      const row = tables.first('mail_bulk_jobs', (r) => r.id === key);
      return row ? mailBulkJobFromRow(row) : null;
    },
    async markRunning(id) {
      const key = idOf(id);
      const now = new Date();
      tables.update('mail_bulk_jobs', (r) => r.id === key, {
        status: 'running',
        started_at: now,
        updated_at: now,
      });
    },
    async setTotal(id, total) {
      const key = idOf(id);
      tables.update('mail_bulk_jobs', (r) => r.id === key, { total, updated_at: new Date() });
    },
    async recordProgress(id, progress) {
      const key = idOf(id);
      tables.update('mail_bulk_jobs', (r) => r.id === key, {
        succeeded: progress.succeeded,
        failed: progress.failed,
        failures: JSON.stringify(progress.failures),
        updated_at: new Date(),
      });
    },
    async finish(id, outcome) {
      const key = idOf(id);
      const now = new Date();
      tables.update('mail_bulk_jobs', (r) => r.id === key, {
        status: outcome.status,
        ...(outcome.lastError !== undefined ? { last_error: outcome.lastError } : {}),
        finished_at: now,
        updated_at: now,
      });
    },
  };
}
