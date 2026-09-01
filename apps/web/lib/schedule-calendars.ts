/**
 * The org's holiday calendars, dates included — the schedule editor's live
 * next-run preview computes client-side with the same function the server
 * uses, so it needs the real blackout dates, not just names. Used by every
 * page that mounts ScheduleEditor (the agent builder's own fetch lives in
 * apps/web/lib/agents/builder-data.ts; this is the batch-job schedule pages'
 * copy of the same query).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isBlackoutEntry, type BlackoutEntry } from '@renkei/agents';

export interface CalendarOption {
  id: string;
  name: string;
  dates: BlackoutEntry[];
}

export async function loadCalendarOptions(db: Kysely<DB>, tenantId: string): Promise<CalendarOption[]> {
  const rows = await db
    .selectFrom('schedule_calendars')
    .select(['id', 'name', 'dates'])
    .where('tenant_id', '=', tenantId)
    .orderBy('name')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    dates: Array.isArray(row.dates) ? row.dates.filter(isBlackoutEntry) : [],
  }));
}
