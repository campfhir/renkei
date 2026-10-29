import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { coachMarkFromRow, coachMarkValues } from './record';
import type { CoachMarkStore } from './types';

export function memoryCoachMarks(tables: MemoryTables): CoachMarkStore {
  return {
    async list(subject) {
      return orderBy(
        tables.select('coach_mark_progress', (r) => r.subject === subject),
        [(r) => r.tour_id]
      ).map(coachMarkFromRow);
    },
    // No lock needed: `next` is synchronous, so nothing else runs between
    // this read and this write.
    async apply(subject, tourId, next) {
      const existing = tables.first(
        'coach_mark_progress',
        (r) => r.subject === subject && r.tour_id === tourId
      );
      const record = next(existing ? coachMarkFromRow(existing) : null);
      const date = (value: string | null) => (value === null ? null : new Date(value));
      const values = {
        ...coachMarkValues(record, ''),
        last_viewed_at: new Date(record.lastViewedAt),
        completed_at: date(record.completedAt),
        dismissed_at: date(record.dismissedAt),
        reported_at: new Date(record.reportedAt),
        updated_at: new Date(),
      };
      tables.upsert(
        'coach_mark_progress',
        { subject, tour_id: tourId, first_viewed_at: new Date(record.firstViewedAt), ...values },
        ['subject', 'tour_id'],
        values
      );
      return record;
    },
    async listAll() {
      return orderBy(
        tables.select('coach_mark_progress'),
        [(r) => r.updated_at, 'desc'],
        [(r) => r.subject],
        [(r) => r.tour_id]
      ).map((row) => ({ subject: row.subject, progress: coachMarkFromRow(row) }));
    },
  };
}
