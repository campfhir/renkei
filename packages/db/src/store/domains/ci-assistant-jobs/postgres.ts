import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { jobFromRow, outcomeColumns } from './record';
import type { CiAssistantJobStore } from './types';

export function postgresCiAssistantJobs(db: () => Kysely<DB>): CiAssistantJobStore {
  return {
    async create(job, at) {
      const row = await db()
        .insertInto('ci_assistant_jobs')
        .values({
          id: job.id,
          subject: job.subject,
          project_id: job.projectId,
          status: 'running',
          step: job.step,
          created_at: at,
          updated_at: at,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return jobFromRow(row);
    },
    async find(subject, id) {
      const row = await db()
        .selectFrom('ci_assistant_jobs')
        .selectAll()
        .where('subject', '=', subject)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? jobFromRow(row) : null;
    },
    async progress(id, step, at) {
      const result = await db()
        .updateTable('ci_assistant_jobs')
        .set({ step, updated_at: at })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async finish(id, outcome, at) {
      const columns = outcomeColumns(outcome, at);
      const result = await db()
        .updateTable('ci_assistant_jobs')
        .set({
          ...columns,
          result: columns.result === null ? null : JSON.stringify(columns.result),
        })
        .where('id', '=', id)
        .where('status', '=', 'running')
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async pruneBefore(before) {
      const result = await db()
        .deleteFrom('ci_assistant_jobs')
        .where('created_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
