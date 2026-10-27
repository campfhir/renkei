import { getDataStore, type CoachMarkProgressRecord } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { applyCoachMarkEvent, type CoachMarkRecord } from './progress';
import type { CoachMarkProgressView, CoachMarkStatus } from './types';

/**
 * Coach-mark progress (`coach_mark_progress`, migration 114), read and
 * written through the data store. The reducer in progress.ts decides what a
 * row becomes; this file only fetches it and puts it back. No cache: the
 * layout reads a person's rows once per page, and a stale read would show
 * a tour they just finished.
 */

const STATUSES: readonly CoachMarkStatus[] = ['viewed', 'completed', 'dismissed'];

function isCoachMarkStatus(value: string): value is CoachMarkStatus {
  return STATUSES.some((status) => status === value);
}

function toView(record: CoachMarkProgressRecord): CoachMarkProgressView {
  return { ...record, status: isCoachMarkStatus(record.status) ? record.status : 'viewed' };
}

/** Every tour this person has a row for. Never throws: a failure reads as nothing seen. */
export async function listCoachMarkProgress(subject: string): Promise<CoachMarkProgressView[]> {
  const result = await wrapAsync(
    () => getDataStore().coachMarks.list(subject),
    'DB_ERROR' as const
  );
  if (!result.ok) return [];
  return result.val.map(toView);
}

/**
 * Apply one reported event to this person's row for the tour and persist it.
 *
 * Read, reduce, write as one step: two reports for the same row can arrive
 * together (a 'step' and the 'completed' right behind it, or two tabs), and
 * without that each would read the row before the other wrote it, and the
 * later write would carry the earlier word. The store makes each apply
 * whole (Postgres with an advisory lock, since the first report of a tour
 * has no row to lock yet); the reducer's own clock check (progress.ts)
 * makes their order irrelevant.
 */
export async function recordCoachMarkEvent(
  subject: string,
  record: CoachMarkRecord
): Promise<Result<CoachMarkProgressView, 'DB_ERROR'>> {
  const now = new Date().toISOString();
  const written = await wrapAsync(
    () =>
      getDataStore().coachMarks.apply(subject, record.tourId, (existing) =>
        applyCoachMarkEvent(existing ? toView(existing) : null, record, now)
      ),
    'DB_ERROR' as const
  );
  if (!written.ok) return err('DB_ERROR' as const);
  return ok(toView(written.val));
}

/** One person's rows on the operator's report. */
export interface CoachMarkPersonReport {
  subject: string;
  displayName: string | null;
  email: string | null;
  tours: CoachMarkProgressView[];
}

/**
 * Every row in the deployment, grouped by person and joined to the
 * identity spine for a name — the shape the admin report renders. Ordered
 * by the most recent activity first, so the people currently exploring
 * lead. Null when the store cannot be read, so the page can say so rather
 * than show an empty report.
 */
export async function listCoachMarkReport(): Promise<CoachMarkPersonReport[] | null> {
  const store = getDataStore();
  const result = await wrapAsync(
    () => Promise.all([store.coachMarks.listAll(), store.identities.list()]),
    'DB_ERROR' as const
  );
  if (!result.ok) return null;
  const [rows, identities] = result.val;
  const names = new Map(identities.map((identity) => [identity.subject, identity]));

  const people = new Map<string, CoachMarkPersonReport>();
  for (const row of rows) {
    let person = people.get(row.subject);
    if (!person) {
      const identity = names.get(row.subject);
      person = {
        subject: row.subject,
        displayName: identity?.displayName ?? null,
        email: identity?.email ?? null,
        tours: [],
      };
      people.set(row.subject, person);
    }
    person.tours.push(toView(row.progress));
  }
  return [...people.values()];
}
