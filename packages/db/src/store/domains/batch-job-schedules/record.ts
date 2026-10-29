import type { Selectable } from 'kysely';
import type { BatchJobSchedules } from '../../../db.types';
import type { BatchJobSchedulePatch, BatchJobScheduleRecord, NewBatchJobSchedule } from './types';

export const SCHEDULE_COLUMNS = [
  'id',
  'subject',
  'name',
  'kind',
  'config',
  'schedule_config',
  'enabled',
  'next_run_at',
  'last_fired_at',
  'last_error',
  'created_at',
] as const;

type ScheduleRow = Pick<Selectable<BatchJobSchedules>, (typeof SCHEDULE_COLUMNS)[number]>;

const dateOrNull = (value: Date | string | null): Date | null =>
  value === null ? null : new Date(value);

export function scheduleFromRow(row: ScheduleRow): BatchJobScheduleRecord {
  return {
    id: row.id,
    subject: row.subject,
    name: row.name,
    kind: row.kind,
    config: row.config ?? null,
    scheduleConfig: row.schedule_config ?? null,
    enabled: row.enabled,
    nextRunAt: dateOrNull(row.next_run_at),
    lastFiredAt: dateOrNull(row.last_fired_at),
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
  };
}

const json = (value: unknown): string => JSON.stringify(value ?? {});

export function scheduleValues(schedule: NewBatchJobSchedule) {
  return {
    id: schedule.id ?? globalThis.crypto.randomUUID(),
    subject: schedule.subject,
    name: schedule.name,
    kind: schedule.kind,
    config: json(schedule.config),
    schedule_config: json(schedule.scheduleConfig),
    next_run_at: schedule.nextRunAt,
  };
}

/** The columns a patch sets (updated_at aside). */
export function schedulePatch(patch: BatchJobSchedulePatch) {
  return {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.config !== undefined ? { config: json(patch.config) } : {}),
    ...(patch.scheduleConfig !== undefined ? { schedule_config: json(patch.scheduleConfig) } : {}),
    ...(patch.nextRunAt !== undefined ? { next_run_at: patch.nextRunAt } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
}
