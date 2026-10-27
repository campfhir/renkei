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
  };
}
