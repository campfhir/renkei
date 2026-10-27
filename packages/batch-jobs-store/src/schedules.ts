/**
 * batch_job_schedules, through the data store
 * (`getDataStore().batchJobSchedules`) — the recurring recipe a batch is
 * defined once against, mirroring agents/agent_triggers' split adapted to
 * batch jobs' simpler shape (one recurring definition, no event/api/agent
 * trigger kinds). Each firing creates an ordinary `batch_jobs` row tagged
 * with `schedule_id` — see store.ts's `createBatch`.
 *
 * `schedule_config` is a serialized `ScheduleConfig` (packages/agents/src/recurrence.ts)
 * — this package does not import @renkei/agents itself (kept dependency-light,
 * the connector-* precedent); callers own parsing/serializing it and pass
 * `nextRunAt` in, already computed. The due-row scan and the optimistic-lock
 * advance-then-fire the sweep needs live in apps/worker (mirroring
 * apps/worker-agents/src/schedule-sweep.ts, which does its own raw queries
 * rather than going through a store abstraction) — this file is CRUD only.
 *
 * Names are unique across the organization: a clashing create or rename
 * rejects with `isDuplicateScheduleName(error)` true.
 */

import { getDataStore, type BatchJobScheduleRecord } from '@renkei/db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BatchJobScheduleRow {
  id: string;
  subject: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  schedule_config: Record<string, unknown>;
  enabled: boolean;
  next_run_at: Date | null;
  last_fired_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

function scheduleOf(record: BatchJobScheduleRecord): BatchJobScheduleRow {
  return {
    id: record.id,
    subject: record.subject,
    name: record.name,
    kind: record.kind,
    config: isRecord(record.config) ? record.config : {},
    schedule_config: isRecord(record.scheduleConfig) ? record.scheduleConfig : {},
    enabled: record.enabled,
    next_run_at: record.nextRunAt,
    last_fired_at: record.lastFiredAt,
    last_error: record.lastError,
    created_at: record.createdAt,
  };
}

/** The refusal a create or rename gets when another schedule already has that name. */
export function isDuplicateScheduleName(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const constraint = 'constraint' in error ? error.constraint : undefined;
  const message = 'message' in error ? error.message : undefined;
  return (
    constraint === 'batch_job_schedules_name' ||
    (typeof message === 'string' && message.includes('batch_job_schedules_name'))
  );
}

export interface CreateScheduleInput {
  subject: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  scheduleConfig: Record<string, unknown>;
  /** Already computed by the caller (computeNextRunForSchedule) — this package stays schedule-math-free. */
  nextRunAt: Date;
}

export async function createSchedule(input: CreateScheduleInput): Promise<BatchJobScheduleRow> {
  return scheduleOf(
    await getDataStore().batchJobSchedules.create({
      subject: input.subject,
      name: input.name,
      kind: input.kind,
      config: input.config,
      scheduleConfig: input.scheduleConfig,
      nextRunAt: input.nextRunAt,
    })
  );
}

export async function getSchedule(scheduleId: string): Promise<BatchJobScheduleRow | undefined> {
  const record = await getDataStore().batchJobSchedules.get(scheduleId);
  return record ? scheduleOf(record) : undefined;
}

/** By name (ties by id). */
export async function listSchedules(subject: string): Promise<BatchJobScheduleRow[]> {
  return (await getDataStore().batchJobSchedules.list(subject)).map(scheduleOf);
}

export interface UpdateScheduleInput {
  name?: string;
  config?: Record<string, unknown>;
  scheduleConfig?: Record<string, unknown>;
  /** Recomputed by the caller whenever config/scheduleConfig actually changed. */
  nextRunAt?: Date;
  enabled?: boolean;
}

export async function updateSchedule(
  scheduleId: string,
  input: UpdateScheduleInput
): Promise<BatchJobScheduleRow | undefined> {
  const record = await getDataStore().batchJobSchedules.update(scheduleId, input);
  return record ? scheduleOf(record) : undefined;
}

export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  return getDataStore().batchJobSchedules.delete(scheduleId);
}
