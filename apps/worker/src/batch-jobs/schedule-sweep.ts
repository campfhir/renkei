/**
 * Firing batch-job schedules — apps/worker-agents/src/schedule-sweep.ts's
 * pattern (advance-then-fire under an optimistic lock, so N sweep replicas
 * fire a due schedule exactly once) applied to `batch_job_schedules`.
 *
 * Firing is kind-generic: it just creates an ordinary `batch_jobs` row
 * (name/kind/config carried over from the schedule) tagged with
 * `schedule_id` and enqueues discovery — kind dispatch
 * (apps/worker/src/batch-jobs/kinds.ts) picks up from there exactly like a
 * one-off batch would, so a future batch kind needs no change here.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { createBatch, enqueueDiscover } from '@renkei/batch-jobs-store';
import {
  blackoutPredicate,
  computeNextRunForSchedule,
  isBlackoutEntry,
  parseScheduleConfig,
  type BlackoutEntry,
} from '@renkei/agents';
import { logger } from '../logger';

const MAX_PER_PASS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Same calendar overlay the agent schedule sweep applies — see its own comment. */
async function calendarDatesOf(
  db: Kysely<DB>,
  tenantId: string,
  calendarId: string
): Promise<BlackoutEntry[]> {
  const row = await db
    .selectFrom('schedule_calendars')
    .select(['dates'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', calendarId)
    .executeTakeFirst();
  if (!row) {
    logger.warn('schedule calendar {calendarId} not found; firing without blackouts', {
      component: 'worker/batch-jobs-schedule',
      calendarId,
      tenantId,
    });
    return [];
  }
  return Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : [];
}

export function createBatchScheduleSweep(db: Kysely<DB>, producer: QueueProducer) {
  return async function sweep(): Promise<void> {
    const due = await db
      .selectFrom('batch_job_schedules')
      .select(['id', 'tenant_id', 'subject', 'name', 'kind', 'config', 'schedule_config', 'next_run_at'])
      .where('enabled', '=', true)
      .where('next_run_at', 'is not', null)
      .where('next_run_at', '<=', sql<Date>`NOW()`)
      .orderBy('next_run_at')
      .limit(MAX_PER_PASS)
      .execute();

    for (const row of due) {
      const config = parseScheduleConfig(row.schedule_config);
      if (!config) {
        await recordScheduleError(db, row.id, 'The schedule is malformed and was turned off.', true);
        continue;
      }

      const observed = row.next_run_at;
      if (!observed) continue;
      const calendarDates = config.calendarId
        ? await calendarDatesOf(db, row.tenant_id, config.calendarId)
        : [];
      let next: Date;
      try {
        next = computeNextRunForSchedule(config, new Date(), blackoutPredicate(calendarDates));
      } catch {
        await recordScheduleError(
          db,
          row.id,
          'No next occurrence could be found (check blackout dates); turned off.',
          true
        );
        continue;
      }

      // The optimistic lock: one replica advances the row, the rest lose.
      const advanced = await db
        .updateTable('batch_job_schedules')
        .set({ next_run_at: next, last_fired_at: sql`NOW()`, updated_at: sql`NOW()` })
        .where('id', '=', row.id)
        .where('next_run_at', '=', observed)
        .executeTakeFirst();
      if (Number(advanced.numUpdatedRows ?? 0) === 0) continue;

      try {
        const batch = await createBatch(db, {
          tenantId: row.tenant_id,
          subject: row.subject,
          name: row.name,
          kind: row.kind,
          config: isRecord(row.config) ? row.config : {},
          scheduleId: row.id,
        });
        await enqueueDiscover(producer, row.tenant_id, batch.id);
        await db
          .updateTable('batch_job_schedules')
          .set({ last_error: null, updated_at: sql`NOW()` })
          .where('id', '=', row.id)
          .execute();
        logger.debug('schedule fired: batch {batchId} for schedule {scheduleId}', {
          component: 'worker/batch-jobs-schedule',
          batchId: batch.id,
          scheduleId: row.id,
          tenantId: row.tenant_id,
          subject: row.subject,
        });
      } catch (error) {
        await recordScheduleError(
          db,
          row.id,
          error instanceof Error ? error.message : 'The batch could not be started.',
          false
        );
      }
    }
  };
}

async function recordScheduleError(
  db: Kysely<DB>,
  scheduleId: string,
  message: string,
  disable: boolean
): Promise<void> {
  await db
    .updateTable('batch_job_schedules')
    .set({
      last_error: message,
      updated_at: sql`NOW()`,
      ...(disable ? { enabled: false } : {}),
    })
    .where('id', '=', scheduleId)
    .execute();
}
