import { orderBy, page } from '../../memory/order';
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
