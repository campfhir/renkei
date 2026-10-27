import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, MailBulkJobs } from '../../../db.types';
import type { MailBulkJobRecord, MailBulkJobStore, NewMailBulkJob } from './types';

export function mailBulkJobFromRow(row: Selectable<MailBulkJobs>): MailBulkJobRecord {
  return {
    id: row.id,
    subject: row.subject,
    accountId: row.account_id,
    action: row.action,
    params: row.params ?? null,
    selection: row.selection ?? null,
    status: row.status,
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    failures: row.failures ?? null,
    lastError: row.last_error,
    startedAt: row.started_at ? new Date(row.started_at) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
  };
}

export function mailBulkJobValues(job: NewMailBulkJob) {
  return {
    id: job.id,
    subject: job.subject,
    account_id: job.accountId,
    action: job.action,
    params: JSON.stringify(job.params),
    selection: JSON.stringify(job.selection),
  };
}

export function postgresMailBulkJobs(db: () => Kysely<DB>): MailBulkJobStore {
  return {
    async create(job) {
      await db().insertInto('mail_bulk_jobs').values(mailBulkJobValues(job)).execute();
    },
    async markFailed(id, error) {
      await db()
        .updateTable('mail_bulk_jobs')
        .set({ status: 'failed', last_error: error })
        .where('id', '=', id)
        .execute();
    },
    async getOwned(id, subject) {
      const row = await db()
        .selectFrom('mail_bulk_jobs')
        .selectAll()
        .where('id', '=', id)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? mailBulkJobFromRow(row) : null;
    },
    async get(id) {
      const row = await db()
        .selectFrom('mail_bulk_jobs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? mailBulkJobFromRow(row) : null;
    },
    async markRunning(id) {
      await db()
        .updateTable('mail_bulk_jobs')
        .set({ status: 'running', started_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async setTotal(id, total) {
      await db()
        .updateTable('mail_bulk_jobs')
        .set({ total, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async recordProgress(id, progress) {
      await db()
        .updateTable('mail_bulk_jobs')
        .set({
          succeeded: progress.succeeded,
          failed: progress.failed,
          failures: JSON.stringify(progress.failures),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .execute();
    },
    async finish(id, outcome) {
      await db()
        .updateTable('mail_bulk_jobs')
        .set({
          status: outcome.status,
          ...(outcome.lastError !== undefined ? { last_error: outcome.lastError } : {}),
          finished_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .execute();
    },
  };
}
