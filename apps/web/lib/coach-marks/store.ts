import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { applyCoachMarkEvent, type CoachMarkRecord } from './progress';
import type { CoachMarkProgressView, CoachMarkStatus } from './types';

/**
 * `coach_mark_progress` (migration 114), read and written. The reducer in
 * progress.ts decides what a row becomes; this file only fetches it and
 * puts it back. No cache: the layout reads a person's rows once per page,
 * and a stale read would show a tour they just finished.
 */

interface ProgressRow {
  tour_id: string;
  tour_version: number;
  status: string;
  step_reached: number;
  steps_total: number;
  view_count: number;
  completed_count: number;
  dismissed_count: number;
  first_viewed_at: Date | string;
  last_viewed_at: Date | string;
  completed_at: Date | string | null;
  dismissed_at: Date | string | null;
}

const STATUSES: readonly CoachMarkStatus[] = ['viewed', 'completed', 'dismissed'];

function isCoachMarkStatus(value: string): value is CoachMarkStatus {
  return STATUSES.some((status) => status === value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toView(row: ProgressRow): CoachMarkProgressView {
  return {
    tourId: row.tour_id,
    version: row.tour_version,
    status: isCoachMarkStatus(row.status) ? row.status : 'viewed',
    stepReached: row.step_reached,
    stepsTotal: row.steps_total,
    viewCount: row.view_count,
    completedCount: row.completed_count,
    dismissedCount: row.dismissed_count,
    firstViewedAt: iso(row.first_viewed_at),
    lastViewedAt: iso(row.last_viewed_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    dismissedAt: row.dismissed_at === null ? null : iso(row.dismissed_at),
  };
}

const COLUMNS = [
  'tour_id',
  'tour_version',
  'status',
  'step_reached',
  'steps_total',
  'view_count',
  'completed_count',
  'dismissed_count',
  'first_viewed_at',
  'last_viewed_at',
  'completed_at',
  'dismissed_at',
] as const;

/** Every tour this person has a row for. Never throws: a failure reads as nothing seen. */
export async function listCoachMarkProgress(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<CoachMarkProgressView[]> {
  const result = await wrapAsync(
    () =>
      db
        .selectFrom('coach_mark_progress')
        .select(COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .orderBy('tour_id')
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return [];
  return result.val.map(toView);
}

/** Apply one reported event to this person's row for the tour and persist it. */
export async function recordCoachMarkEvent(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  record: CoachMarkRecord
): Promise<Result<CoachMarkProgressView, 'DB_ERROR'>> {
  const now = new Date().toISOString();
  const existing = await wrapAsync(
    () =>
      db
        .selectFrom('coach_mark_progress')
        .select(COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .where('tour_id', '=', record.tourId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!existing.ok) return err('DB_ERROR' as const);

  const next = applyCoachMarkEvent(existing.val ? toView(existing.val) : null, record, now);
  const values = {
    tour_version: next.version,
    status: next.status,
    step_reached: next.stepReached,
    steps_total: next.stepsTotal,
    view_count: next.viewCount,
    completed_count: next.completedCount,
    dismissed_count: next.dismissedCount,
    last_viewed_at: next.lastViewedAt,
    completed_at: next.completedAt,
    dismissed_at: next.dismissedAt,
    updated_at: now,
  };

  const written = await wrapAsync(
    () =>
      db
        .insertInto('coach_mark_progress')
        .values({
          tenant_id: tenantId,
          subject,
          tour_id: next.tourId,
          first_viewed_at: next.firstViewedAt,
          ...values,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'subject', 'tour_id']).doUpdateSet(values))
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return err('DB_ERROR' as const);
  return ok(next);
}

/** One person's rows on the operator's report. */
export interface CoachMarkPersonReport {
  subject: string;
  displayName: string | null;
  email: string | null;
  tours: CoachMarkProgressView[];
}

/**
 * Every row in the tenant, grouped by person and joined to the identity
 * spine for a name — the shape the admin report renders. Ordered by the
 * most recent activity first, so the people currently exploring lead.
 */
export async function listCoachMarkReport(
  db: Kysely<DB>,
  tenantId: string
): Promise<CoachMarkPersonReport[]> {
  const result = await wrapAsync(
    () =>
      db
        .selectFrom('coach_mark_progress')
        .leftJoin('identities', (join) =>
          join
            .onRef('identities.subject', '=', 'coach_mark_progress.subject')
            .onRef('identities.tenant_id', '=', 'coach_mark_progress.tenant_id')
        )
        .select([
          'coach_mark_progress.subject as subject',
          'coach_mark_progress.tour_id as tour_id',
          'coach_mark_progress.tour_version as tour_version',
          'coach_mark_progress.status as status',
          'coach_mark_progress.step_reached as step_reached',
          'coach_mark_progress.steps_total as steps_total',
          'coach_mark_progress.view_count as view_count',
          'coach_mark_progress.completed_count as completed_count',
          'coach_mark_progress.dismissed_count as dismissed_count',
          'coach_mark_progress.first_viewed_at as first_viewed_at',
          'coach_mark_progress.last_viewed_at as last_viewed_at',
          'coach_mark_progress.completed_at as completed_at',
          'coach_mark_progress.dismissed_at as dismissed_at',
          'coach_mark_progress.updated_at as updated_at',
          'identities.display_name as display_name',
          'identities.email as email',
        ])
        .where('coach_mark_progress.tenant_id', '=', tenantId)
        .orderBy('coach_mark_progress.updated_at', 'desc')
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return [];

  const people = new Map<string, CoachMarkPersonReport>();
  for (const row of result.val) {
    let person = people.get(row.subject);
    if (!person) {
      person = {
        subject: row.subject,
        displayName: row.display_name,
        email: row.email,
        tours: [],
      };
      people.set(row.subject, person);
    }
    person.tours.push(toView(row));
  }
  return [...people.values()];
}
