/**
 * next_run_at for a batch-job schedule — the same computation
 * apps/web/lib/agents/store.ts's trigger reconcile does for an agent
 * schedule trigger, applied to batch_job_schedules. A calendarId the
 * tenant does not own resolves to no calendar (dropped, never looked up
 * cross-tenant) rather than an error.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  blackoutPredicate,
  computeNextRunForSchedule,
  isBlackoutEntry,
  type BlackoutEntry,
  type ScheduleConfig,
} from '@renkei/agents';

export async function nextRunAtFor(
  db: Kysely<DB>,
  tenantId: string,
  config: ScheduleConfig
): Promise<Date> {
  let calendarDates: BlackoutEntry[] = [];
  if (config.calendarId) {
    const row = await db
      .selectFrom('schedule_calendars')
      .select(['dates'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', config.calendarId)
      .executeTakeFirst();
    calendarDates = row && Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : [];
  }
  return computeNextRunForSchedule(config, new Date(), blackoutPredicate(calendarDates));
}
