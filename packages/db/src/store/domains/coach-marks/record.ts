import type { Selectable } from 'kysely';
import type { CoachMarkProgress } from '../../../db.types';
import type { CoachMarkProgressRecord } from './types';

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function coachMarkFromRow(row: Selectable<CoachMarkProgress>): CoachMarkProgressRecord {
  return {
    tourId: row.tour_id,
    version: row.tour_version,
    status: row.status,
    stepReached: row.step_reached,
    stepsTotal: row.steps_total,
    viewCount: row.view_count,
    completedCount: row.completed_count,
    dismissedCount: row.dismissed_count,
    firstViewedAt: iso(row.first_viewed_at),
    lastViewedAt: iso(row.last_viewed_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    dismissedAt: row.dismissed_at === null ? null : iso(row.dismissed_at),
    reportedAt: iso(row.reported_at),
  };
}

/** The columns an apply writes, besides the key and the first view. */
export function coachMarkValues(record: CoachMarkProgressRecord, now: string) {
  return {
    tour_version: record.version,
    status: record.status,
    step_reached: record.stepReached,
    steps_total: record.stepsTotal,
    view_count: record.viewCount,
    completed_count: record.completedCount,
    dismissed_count: record.dismissedCount,
    last_viewed_at: record.lastViewedAt,
    completed_at: record.completedAt,
    dismissed_at: record.dismissedAt,
    reported_at: record.reportedAt,
    updated_at: now,
  };
}
