import { orderBy, sameValue } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { scheduleFromRow, schedulePatch, scheduleValues } from './record';
import type { BatchJobScheduleStore } from './types';

export function memoryBatchJobSchedules(tables: MemoryTables): BatchJobScheduleStore {
  const key = (scheduleId: string) => tables.param('batch_job_schedules', 'id', scheduleId);
  return {
    async create(schedule) {
      return scheduleFromRow(tables.insert('batch_job_schedules', scheduleValues(schedule)));
    },
    async get(scheduleId) {
      const id = key(scheduleId);
      const row = tables.first('batch_job_schedules', (r) => sameValue(r.id, id));
      return row ? scheduleFromRow(row) : undefined;
    },
    async list(subject) {
      const rows = tables.select('batch_job_schedules', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.name], [(r) => r.id]).map(scheduleFromRow);
    },
    async update(scheduleId, patch) {
      const id = key(scheduleId);
      const [row] = tables.update('batch_job_schedules', (r) => sameValue(r.id, id), {
        ...schedulePatch(patch),
        updated_at: new Date(),
      });
      return row ? scheduleFromRow(row) : undefined;
    },
    async delete(scheduleId) {
      const id = key(scheduleId);
      return tables.delete('batch_job_schedules', (r) => sameValue(r.id, id)).length > 0;
    },
    async calendarDates(calendarId) {
      const id = tables.param('schedule_calendars', 'id', calendarId);
      const row = tables.first('schedule_calendars', (r) => sameValue(r.id, id));
      return row ? row.dates : undefined;
    },
  };
}
