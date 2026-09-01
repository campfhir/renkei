/**
 * Postgres access for batch_job_schedules — the recurring recipe a batch is
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
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@renkei/db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BatchJobScheduleRow {
  id: string;
  tenant_id: string;
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

const SCHEDULE_COLUMNS = [
  'id',
  'tenant_id',
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

function scheduleOf(row: {
  id: string;
  tenant_id: string;
  subject: string;
  name: string;
  kind: string;
  config: unknown;
  schedule_config: unknown;
  enabled: boolean;
  next_run_at: Date | null;
  last_fired_at: Date | null;
  last_error: string | null;
  created_at: Date;
}): BatchJobScheduleRow {
  return {
    ...row,
    config: isRecord(row.config) ? row.config : {},
    schedule_config: isRecord(row.schedule_config) ? row.schedule_config : {},
  };
}

export interface CreateScheduleInput {
  tenantId: string;
  subject: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  scheduleConfig: Record<string, unknown>;
  /** Already computed by the caller (computeNextRunForSchedule) — this package stays schedule-math-free. */
  nextRunAt: Date;
}

export async function createSchedule(
  db: Kysely<DB>,
  input: CreateScheduleInput
): Promise<BatchJobScheduleRow> {
  const row = await db
    .insertInto('batch_job_schedules')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      name: input.name,
      kind: input.kind,
      config: JSON.stringify(input.config),
      schedule_config: JSON.stringify(input.scheduleConfig),
      next_run_at: input.nextRunAt,
    })
    .returning(SCHEDULE_COLUMNS)
    .executeTakeFirstOrThrow();
  return scheduleOf(row);
}

export async function getSchedule(
  db: Kysely<DB>,
  scheduleId: string,
  tenantId: string
): Promise<BatchJobScheduleRow | undefined> {
  const row = await db
    .selectFrom('batch_job_schedules')
    .select(SCHEDULE_COLUMNS)
    .where('id', '=', scheduleId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return row ? scheduleOf(row) : undefined;
}

export async function listSchedules(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<BatchJobScheduleRow[]> {
  const rows = await db
    .selectFrom('batch_job_schedules')
    .select(SCHEDULE_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .orderBy('name')
    .execute();
  return rows.map(scheduleOf);
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
  db: Kysely<DB>,
  scheduleId: string,
  tenantId: string,
  input: UpdateScheduleInput
): Promise<BatchJobScheduleRow | undefined> {
  const row = await db
    .updateTable('batch_job_schedules')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.config !== undefined ? { config: JSON.stringify(input.config) } : {}),
      ...(input.scheduleConfig !== undefined
        ? { schedule_config: JSON.stringify(input.scheduleConfig) }
        : {}),
      ...(input.nextRunAt !== undefined ? { next_run_at: input.nextRunAt } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updated_at: sql`NOW()`,
    })
    .where('id', '=', scheduleId)
    .where('tenant_id', '=', tenantId)
    .returning(SCHEDULE_COLUMNS)
    .executeTakeFirst();
  return row ? scheduleOf(row) : undefined;
}

export async function deleteSchedule(
  db: Kysely<DB>,
  scheduleId: string,
  tenantId: string
): Promise<boolean> {
  const result = await db
    .deleteFrom('batch_job_schedules')
    .where('id', '=', scheduleId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}
