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

import { getDataStore } from '@renkei/db';
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
import { whoIs } from '../log-actor';
import { isRecord } from '@renkei/guards';
import type { ActorFields } from '@renkei/db';

const COMPONENT = 'worker/batch-jobs-schedule';
const MAX_PER_PASS = 25;

/** Same calendar overlay the agent schedule sweep applies — see its own comment. */
async function calendarDatesOf(
  calendarId: string,
  schedule: { owner: ActorFields; scheduleId: string; name: string }
): Promise<BlackoutEntry[]> {
  const dates = await getDataStore().batchJobSchedules.calendarDates(calendarId);
  if (dates === undefined) {
    logger.warn(
      '{actor}\'s batch schedule "{name}" names a blackout calendar that no longer exists; it fires without blackouts',
      {
        component: 'worker/batch-jobs-schedule',
        ...schedule.owner,
        scheduleId: schedule.scheduleId,
        name: schedule.name,
        calendarId,
      }
    );
    return [];
  }
  return Array.isArray(dates) ? dates.filter(isBlackoutEntry) : [];
}

export function createBatchScheduleSweep(producer: QueueProducer) {
  return async function sweep(): Promise<void> {
    const schedules = getDataStore().batchJobSchedules;
    const due = await schedules.listDue(MAX_PER_PASS);

    for (const row of due) {
      const owner = await whoIs(row.subject);
      const about = { component: COMPONENT, ...owner, scheduleId: row.id, name: row.name };
      const config = parseScheduleConfig(row.scheduleConfig);
      if (!config) {
        await schedules.recordError(row.id, 'The schedule is malformed and was turned off.', {
          disable: true,
        });
        logger.warn(
          '{actor}\'s batch schedule "{name}" is malformed and was turned off; no batch was started',
          about
        );
        continue;
      }

      const observed = row.nextRunAt;
      if (!observed) continue;
      const calendarDates = config.calendarId
        ? await calendarDatesOf(config.calendarId, { owner, scheduleId: row.id, name: row.name })
        : [];
      let next: Date;
      try {
        next = computeNextRunForSchedule(config, new Date(), blackoutPredicate(calendarDates));
      } catch {
        await schedules.recordError(
          row.id,
          'No next occurrence could be found (check blackout dates); turned off.',
          { disable: true }
        );
        logger.warn(
          '{actor}\'s batch schedule "{name}" has no next occurrence (check its blackout dates) and was turned off; no batch was started',
          about
        );
        continue;
      }

      // The optimistic lock: one replica advances the row, the rest lose.
      if (!(await schedules.advance(row.id, observed, next))) continue;

      try {
        const batch = await createBatch({
          subject: row.subject,
          name: row.name,
          kind: row.kind,
          config: isRecord(row.config) ? row.config : {},
          scheduleId: row.id,
        });
        await enqueueDiscover(producer, batch.id);
        await schedules.clearError(row.id);
        logger.debug(
          '{actor}\'s batch schedule "{name}" fired: batch {batchId} was created and its discovery queued',
          { ...about, batchId: batch.id }
        );
      } catch (error) {
        logger.error(
          '{actor}\'s batch schedule "{name}" fired, but no batch was started; the error is recorded on the schedule, which fires again at its next occurrence: {error}',
          {
            ...about,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
        await schedules.recordError(
          row.id,
          error instanceof Error ? error.message : 'The batch could not be started.'
        );
      }
    }
  };
}
