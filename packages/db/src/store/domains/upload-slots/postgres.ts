import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { UPLOAD_SLOT_COLUMNS, uploadSlotFromRow } from './record';
import type { UploadSlotStore } from './types';

export function postgresUploadSlots(db: () => Kysely<DB>): UploadSlotStore {
  return {
    async create(input) {
      await db()
        .insertInto('upload_slots')
        .values({
          id: input.id,
          token_hash: input.tokenHash,
          subject: input.subject,
          account_id: input.accountId,
          kind: input.kind,
          destination: JSON.stringify(input.destination),
          filename: input.filename,
          content_type: input.contentType,
          max_bytes: input.maxBytes,
          expires_at: input.expiresAt,
        })
        .execute();
    },
    async get(slotId) {
      const row = await db()
        .selectFrom('upload_slots')
        .select(UPLOAD_SLOT_COLUMNS)
        .where('id', '=', slotId)
        .executeTakeFirst();
      return row ? uploadSlotFromRow(row) : null;
    },
    async claim(slotId, proof) {
      // Atomic single-use claim; the flip to 'completed' doubles as the busy marker.
      let query = db()
        .updateTable('upload_slots')
        .set({ status: 'completed', completed_at: sql`NOW()` })
        .where('id', '=', slotId)
        .where('status', '=', 'pending')
        .where('expires_at', '>', sql<Date>`NOW()`);
      query =
        'tokenHash' in proof
          ? query.where('token_hash', '=', proof.tokenHash)
          : query.where('subject', '=', proof.subject);
      const row = await query.returning(UPLOAD_SLOT_COLUMNS).executeTakeFirst();
      return row ? uploadSlotFromRow(row) : null;
    },
    async finish(slotId, outcome) {
      await db()
        .updateTable('upload_slots')
        .set({
          status: outcome.ok ? 'completed' : 'failed',
          result: outcome.detail,
          completed_at: sql`NOW()`,
        })
        .where('id', '=', slotId)
        .execute();
    },
    async setDestination(slotId, destination) {
      await db()
        .updateTable('upload_slots')
        .set({ destination: JSON.stringify(destination) })
        .where('id', '=', slotId)
        .execute();
    },
    async expireStale() {
      const result = await db()
        .updateTable('upload_slots')
        .set({ status: 'expired' })
        .where('status', '=', 'pending')
        .where('expires_at', '<', sql<Date>`NOW()`)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async pruneSettled(days, limit) {
      const deleted = await sql<{ id: string }>`
        DELETE FROM upload_slots WHERE id IN (
          SELECT id FROM upload_slots
          WHERE status IN ('completed', 'failed', 'expired')
            AND created_at < NOW() - make_interval(days => ${days})
          ORDER BY created_at, id
          LIMIT ${limit}
        ) RETURNING id
      `.execute(db());
      return deleted.rows.length;
    },
  };
}
