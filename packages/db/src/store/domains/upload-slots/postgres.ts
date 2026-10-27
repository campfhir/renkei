import type { Kysely, Selectable } from 'kysely';
import type { DB, UploadSlots } from '../../../db.types';
import type { NewUploadSlot, UploadSlotRecord, UploadSlotStore } from './types';

export function uploadSlotFromRow(row: Selectable<UploadSlots>): UploadSlotRecord {
  return {
    id: row.id,
    subject: row.subject,
    accountId: row.account_id,
    kind: row.kind,
    destination: row.destination ?? null,
    filename: row.filename,
    contentType: row.content_type,
    maxBytes: row.max_bytes,
    status: row.status,
    result: row.result,
    expiresAt: new Date(row.expires_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

export function uploadSlotValues(slot: NewUploadSlot) {
  return {
    id: slot.id,
    token_hash: slot.tokenHash,
    subject: slot.subject,
    account_id: slot.accountId,
    kind: slot.kind,
    destination: JSON.stringify(slot.destination),
    filename: slot.filename,
    content_type: slot.contentType,
    max_bytes: slot.maxBytes,
    expires_at: slot.expiresAt,
  };
}

export function postgresUploadSlots(db: () => Kysely<DB>): UploadSlotStore {
  return {
    async create(slot) {
      await db().insertInto('upload_slots').values(uploadSlotValues(slot)).execute();
    },
    async get(id) {
      const row = await db()
        .selectFrom('upload_slots')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? uploadSlotFromRow(row) : null;
    },
    async claimPendingByOwner(id, subject, now) {
      const row = await db()
        .updateTable('upload_slots')
        .set({ status: 'completed', completed_at: now })
        .where('id', '=', id)
        .where('subject', '=', subject)
        .where('status', '=', 'pending')
        .where('expires_at', '>', now)
        .returningAll()
        .executeTakeFirst();
      return row ? uploadSlotFromRow(row) : null;
    },
  };
}
