import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { coachMarkFromRow, coachMarkValues } from './record';
import type { CoachMarkStore } from './types';

export function postgresCoachMarks(db: () => Kysely<DB>): CoachMarkStore {
  return {
    async list(subject) {
      const rows = await db()
        .selectFrom('coach_mark_progress')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('tour_id')
        .execute();
      return rows.map(coachMarkFromRow);
    },
    async apply(subject, tourId, next) {
      // Advisory rather than SELECT … FOR UPDATE: the first report of a
      // tour has no row to lock yet.
      const lockKey = `coach_mark_progress:${subject}:${tourId}`;
      return db()
        .transaction()
        .execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`.execute(trx);
          const existing = await trx
            .selectFrom('coach_mark_progress')
            .selectAll()
            .where('subject', '=', subject)
            .where('tour_id', '=', tourId)
            .executeTakeFirst();
          const record = next(existing ? coachMarkFromRow(existing) : null);
          const values = coachMarkValues(record, new Date().toISOString());
          await trx
            .insertInto('coach_mark_progress')
            .values({ subject, tour_id: tourId, first_viewed_at: record.firstViewedAt, ...values })
            .onConflict((oc) => oc.columns(['subject', 'tour_id']).doUpdateSet(values))
            .execute();
          return record;
        });
    },
    async listAll() {
      const rows = await db()
        .selectFrom('coach_mark_progress')
        .selectAll()
        .orderBy('updated_at', 'desc')
        .orderBy('subject')
        .orderBy('tour_id')
        .execute();
      return rows.map((row) => ({ subject: row.subject, progress: coachMarkFromRow(row) }));
    },
  };
}
