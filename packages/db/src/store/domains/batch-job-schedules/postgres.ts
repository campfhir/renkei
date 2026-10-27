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
  };
}
