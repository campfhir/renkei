import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { SCHEDULE_COLUMNS, scheduleFromRow, schedulePatch, scheduleValues } from './record';
import type { BatchJobScheduleStore } from './types';

export function postgresBatchJobSchedules(db: () => Kysely<DB>): BatchJobScheduleStore {
  return {
    async create(schedule) {
      const row = await db()
        .insertInto('batch_job_schedules')
        .values(scheduleValues(schedule))
        .returning(SCHEDULE_COLUMNS)
        .executeTakeFirstOrThrow();
      return scheduleFromRow(row);
    },
    async get(scheduleId) {
      const row = await db()
        .selectFrom('batch_job_schedules')
        .select(SCHEDULE_COLUMNS)
        .where('id', '=', scheduleId)
        .executeTakeFirst();
      return row ? scheduleFromRow(row) : undefined;
    },
    async list(subject) {
      const rows = await db()
        .selectFrom('batch_job_schedules')
        .select(SCHEDULE_COLUMNS)
        .where('subject', '=', subject)
        .orderBy('name')
        .orderBy('id')
        .execute();
      return rows.map(scheduleFromRow);
    },
    async update(scheduleId, patch) {
      const row = await db()
        .updateTable('batch_job_schedules')
        .set({ ...schedulePatch(patch), updated_at: sql`NOW()` })
        .where('id', '=', scheduleId)
        .returning(SCHEDULE_COLUMNS)
        .executeTakeFirst();
      return row ? scheduleFromRow(row) : undefined;
    },
    async delete(scheduleId) {
      const result = await db()
        .deleteFrom('batch_job_schedules')
        .where('id', '=', scheduleId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
    async calendarDates(calendarId) {
      const row = await db()
        .selectFrom('schedule_calendars')
        .select(['dates'])
        .where('id', '=', calendarId)
        .executeTakeFirst();
      return row ? row.dates : undefined;
    },
    async listDue(limit) {
      const rows = await db()
        .selectFrom('batch_job_schedules')
        .select(SCHEDULE_COLUMNS)
        .where('enabled', '=', true)
        .where('next_run_at', 'is not', null)
        .where('next_run_at', '<=', sql<Date>`NOW()`)
        .orderBy('next_run_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(scheduleFromRow);
    },
    async advance(scheduleId, observed, next) {
      const advanced = await db()
        .updateTable('batch_job_schedules')
        .set({ next_run_at: next, last_fired_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', scheduleId)
        .where('next_run_at', '=', observed)
        .executeTakeFirst();
      return Number(advanced.numUpdatedRows ?? 0) > 0;
    },
    async clearError(scheduleId) {
      await db()
        .updateTable('batch_job_schedules')
        .set({ last_error: null, updated_at: sql`NOW()` })
        .where('id', '=', scheduleId)
        .execute();
    },
    async recordError(scheduleId, message, { disable = false } = {}) {
      await db()
        .updateTable('batch_job_schedules')
        .set({
          last_error: message,
          updated_at: sql`NOW()`,
          ...(disable ? { enabled: false } : {}),
        })
        .where('id', '=', scheduleId)
        .execute();
    },
  };
}
