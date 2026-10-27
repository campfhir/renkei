import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { ScheduleCalendarStore } from './types';

function isNameConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === '23505' &&
    String(Reflect.get(error, 'message')).includes('idx_schedule_calendars_name')
  );
}

export function postgresScheduleCalendars(db: () => Kysely<DB>): ScheduleCalendarStore {
  return {
    async list() {
      const rows = await db()
        .selectFrom('schedule_calendars')
        .select(['id', 'name', 'dates', 'updated_at'])
        .orderBy('name')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        dates: row.dates,
        updatedAt: new Date(row.updated_at),
      }));
    },
    async create({ id, name, dates }) {
      try {
        await db()
          .insertInto('schedule_calendars')
          .values({ id, name, dates: JSON.stringify(dates) })
          .execute();
        return 'created';
      } catch (error) {
        if (isNameConflict(error)) return 'duplicate';
        throw error;
      }
    },
    async update(id, { name, dates }) {
      try {
        const updated = await db()
          .updateTable('schedule_calendars')
          .set({ name, dates: JSON.stringify(dates), updated_at: sql`NOW()` })
          .where('id', '=', id)
          .executeTakeFirst();
        return Number(updated.numUpdatedRows ?? 0) === 0 ? 'not-found' : 'updated';
      } catch (error) {
        if (isNameConflict(error)) return 'duplicate';
        throw error;
      }
    },
    async delete(id) {
      const deleted = await db()
        .deleteFrom('schedule_calendars')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(deleted.numDeletedRows ?? 0) > 0;
    },
    async find(id) {
      const row = await db()
        .selectFrom('schedule_calendars')
        .select(['id', 'name', 'dates', 'updated_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row
        ? { id: row.id, name: row.name, dates: row.dates, updatedAt: new Date(row.updated_at) }
        : null;
    },
  };
}
