import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { WebexDirtyWindowRecord, WebexDirtyWindowStore } from './types';

export function dirtyWindowFromRow(row: {
  room_id: string;
  day: string;
  subject: string | null;
  marked_at: Date;
}): WebexDirtyWindowRecord {
  return {
    roomId: row.room_id,
    day: row.day,
    subject: row.subject,
    markedAt: new Date(row.marked_at),
  };
}

export function postgresWebexDirtyWindows(db: () => Kysely<DB>): WebexDirtyWindowStore {
  return {
    async markDirty(roomId, day, subject) {
      await db()
        .insertInto('webex_dirty_windows')
        .values({ room_id: roomId, day, subject, marked_at: sql`NOW()` })
        .onConflict((oc) =>
          oc.columns(['room_id', 'day']).doUpdateSet({
            marked_at: sql`NOW()`,
            // A watcher that is still around beats one that may have opted out.
            subject: sql`COALESCE(EXCLUDED.subject, webex_dirty_windows.subject)`,
          })
        )
        .execute();
    },
    async find(roomId, day) {
      const row = await db()
        .selectFrom('webex_dirty_windows')
        .select(['room_id', 'day', 'subject', 'marked_at'])
        .where('room_id', '=', roomId)
        .where('day', '=', day)
        .executeTakeFirst();
      return row ? dirtyWindowFromRow(row) : null;
    },
  };
}
