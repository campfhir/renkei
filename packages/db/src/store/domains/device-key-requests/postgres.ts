import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { deviceKeyRequestFromRow } from './record';
import type { DeviceKeyRequestStore } from './types';

export function postgresDeviceKeyRequests(db: () => Kysely<DB>): DeviceKeyRequestStore {
  return {
    async listPending(subject, now) {
      const rows = await db()
        .selectFrom('device_key_requests')
        .selectAll()
        .where('subject', '=', subject)
        .where('sealed_key', 'is', null)
        .where('consumed_at', 'is', null)
        .where('denied_at', 'is', null)
        .where('expires_at', '>', now)
        .orderBy('created_at', 'asc')
        .orderBy('id')
        .execute();
      return rows.map(deviceKeyRequestFromRow);
    },
    async purgeBefore(subject, before) {
      const result = await db()
        .deleteFrom('device_key_requests')
        .where('subject', '=', subject)
        .where('created_at', '<', before)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async countSince(subject, since) {
      const row = await db()
        .selectFrom('device_key_requests')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('subject', '=', subject)
        .where('created_at', '>=', since)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },
    async create(input) {
      const row = await db()
        .insertInto('device_key_requests')
        .values({
          subject: input.subject,
          public_key: input.publicKey,
          code: input.code,
          asking_session_id: input.askingSessionId,
          user_agent: input.userAgent,
          expires_at: input.expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return deviceKeyRequestFromRow(row);
    },
    async get(subject, id) {
      const row = await db()
        .selectFrom('device_key_requests')
        .selectAll()
        .where('id', '=', id)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? deviceKeyRequestFromRow(row) : null;
    },
    async recordMiss(id, attempts, deniedAt) {
      await db()
        .updateTable('device_key_requests')
        .set(deniedAt ? { attempts, denied_at: deniedAt } : { attempts })
        .where('id', '=', id)
        .execute();
    },
    async consume(id, at) {
      await db()
        .updateTable('device_key_requests')
        .set({ sealed_key: null, consumed_at: at })
        .where('id', '=', id)
        .execute();
    },
    async seal(id, sealedKey, approvedBySessionId, now) {
      const result = await db()
        .updateTable('device_key_requests')
        .set({ sealed_key: sealedKey, approved_by_session_id: approvedBySessionId })
        .where('id', '=', id)
        .where('sealed_key', 'is', null)
        .where('denied_at', 'is', null)
        .where('expires_at', '>', now)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async deny(subject, id, at) {
      const result = await db()
        .updateTable('device_key_requests')
        .set({ denied_at: at, sealed_key: null })
        .where('id', '=', id)
        .where('subject', '=', subject)
        .where('denied_at', 'is', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
  };
}
