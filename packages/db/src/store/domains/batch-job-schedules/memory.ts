import { orderBy, sameValue } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import { scheduleFromRow, schedulePatch, scheduleValues } from './record';
import type { BatchJobScheduleStore } from './types';

export function memoryBatchJobSchedules(tables: MemoryTables): BatchJobScheduleStore {
  // The schedules store answers a taken name as a duplicate (by constraint name).
  const refuseTakenName = (name: string, except?: string) => {
    if (tables.first('batch_job_schedules', (r) => r.name === name && r.id !== except)) {
      throw uniqueViolation('batch_job_schedules', 'batch_job_schedules_name');
    }
  };
  return {
    async create(schedule) {
      refuseTakenName(schedule.name);
      const now = new Date();
      return scheduleFromRow(
        tables.insert('batch_job_schedules', {
          ...scheduleValues(schedule),
          config: toJson(schedule.config ?? {}),
          schedule_config: toJson(schedule.scheduleConfig ?? {}),
          enabled: true,
          last_fired_at: null,
          last_error: null,
          created_at: now,
          updated_at: now,
        })
      );
    },
    async get(scheduleId) {
      const id = scheduleId;
      const row = tables.first('batch_job_schedules', (r) => sameValue(r.id, id));
      return row ? scheduleFromRow(row) : undefined;
    },
    async list(subject) {
      const rows = tables.select('batch_job_schedules', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.name], [(r) => r.id]).map(scheduleFromRow);
    },
    async update(scheduleId, patch) {
      const id = scheduleId;
      if (patch.name !== undefined) refuseTakenName(patch.name, id);
      const [row] = tables.update('batch_job_schedules', (r) => sameValue(r.id, id), {
        ...schedulePatch(patch),
        ...(patch.config !== undefined ? { config: toJson(patch.config ?? {}) } : {}),
        ...(patch.scheduleConfig !== undefined
          ? { schedule_config: toJson(patch.scheduleConfig ?? {}) }
          : {}),
        updated_at: new Date(),
      });
      return row ? scheduleFromRow(row) : undefined;
    },
    async delete(scheduleId) {
      const id = scheduleId;
      tables.update('batch_jobs', (r) => r.schedule_id === id, { schedule_id: null });
      return tables.delete('batch_job_schedules', (r) => sameValue(r.id, id)).length > 0;
    },
    async calendarDates(calendarId) {
      const id = calendarId;
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
      const id = scheduleId;
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
      const id = scheduleId;
      tables.update('batch_job_schedules', (r) => sameValue(r.id, id), {
        last_error: null,
        updated_at: new Date(),
      });
    },
    async recordError(scheduleId, message, { disable = false } = {}) {
      const id = scheduleId;
      tables.update('batch_job_schedules', (r) => sameValue(r.id, id), {
        last_error: message,
        updated_at: new Date(),
        ...(disable ? { enabled: false } : {}),
      });
    },
  };
}
