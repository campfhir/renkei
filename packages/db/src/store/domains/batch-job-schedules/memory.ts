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
    async listDue(limit) {
      const now = Date.now();
      const due = tables.select(
        'batch_job_schedules',
        (r) => r.enabled && r.next_run_at !== null && r.next_run_at.getTime() <= now
      );
      return orderBy(due, [(r) => r.next_run_at], [(r) => r.id])
        .slice(0, limit)
        .map(scheduleFromRow);
    },
    async advance(scheduleId, observed, next) {
      const id = key(scheduleId);
      const now = new Date();
      return (
        tables.update(
          'batch_job_schedules',
          (r) => sameValue(r.id, id) && sameValue(r.next_run_at, observed),
          { next_run_at: next, last_fired_at: now, updated_at: now }
        ).length > 0
      );
    },
    async clearError(scheduleId) {
      const id = key(scheduleId);
      tables.update('batch_job_schedules', (r) => sameValue(r.id, id), {
        last_error: null,
        updated_at: new Date(),
      });
    },
    async recordError(scheduleId, message, { disable = false } = {}) {
      const id = key(scheduleId);
      tables.update('batch_job_schedules', (r) => sameValue(r.id, id), {
        last_error: message,
        updated_at: new Date(),
        ...(disable ? { enabled: false } : {}),
      });
    },
  };
}
