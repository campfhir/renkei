import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { ScheduleCalendarStore } from './types';

export function memoryScheduleCalendars(tables: MemoryTables): ScheduleCalendarStore {
  return {
    async list() {
      return orderBy(tables.select('schedule_calendars'), [(r) => r.name], [(r) => r.id]).map(
        (row) => ({ id: row.id, name: row.name, dates: row.dates, updatedAt: row.updated_at })
      );
    },
    async create({ id, name, dates }) {
      if (tables.first('schedule_calendars', (r) => r.name === name)) return 'duplicate';
      tables.insert('schedule_calendars', { id, name, dates: JSON.stringify(dates) });
      return 'created';
    },
    async update(id, { name, dates }) {
      const key = tables.param('schedule_calendars', 'id', id);
      if (!tables.first('schedule_calendars', (r) => r.id === key)) return 'not-found';
      if (tables.first('schedule_calendars', (r) => r.name === name && r.id !== key)) {
        return 'duplicate';
      }
      tables.update('schedule_calendars', (r) => r.id === key, {
        name,
        dates: JSON.stringify(dates),
        updated_at: new Date(),
      });
      return 'updated';
    },
    async delete(id) {
      const key = tables.param('schedule_calendars', 'id', id);
      return tables.delete('schedule_calendars', (r) => r.id === key).length > 0;
    },
    async find(id) {
      const key = tables.param('schedule_calendars', 'id', id);
      const row = tables.first('schedule_calendars', (r) => r.id === key);
      return row
        ? { id: row.id, name: row.name, dates: row.dates, updatedAt: row.updated_at }
        : null;
    },
  };
}
