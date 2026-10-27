import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { deviceKeyRequestFromRow } from './record';
import type { DeviceKeyRequestStore } from './types';

const TABLE = 'device_key_requests';

export function memoryDeviceKeyRequests(tables: MemoryTables): DeviceKeyRequestStore {
  const idOf = (id: string) => tables.param(TABLE, 'id', id);
  return {
    async listPending(subject, now) {
      const rows = tables.select(
        TABLE,
        (r) =>
          r.subject === subject &&
          r.sealed_key === null &&
          r.consumed_at === null &&
          r.denied_at === null &&
          r.expires_at.getTime() > now.getTime()
      );
      return orderBy(rows, [(r) => r.created_at], [(r) => r.id]).map(deviceKeyRequestFromRow);
    },
    async purgeBefore(subject, before) {
      return tables.delete(
        TABLE,
        (r) => r.subject === subject && r.created_at.getTime() < before.getTime()
      ).length;
    },
    async countSince(subject, since) {
      return tables.select(
        TABLE,
        (r) => r.subject === subject && r.created_at.getTime() >= since.getTime()
      ).length;
    },
    async create(input) {
      return deviceKeyRequestFromRow(
        tables.insert(TABLE, {
          subject: input.subject,
          public_key: input.publicKey,
          code: input.code,
          asking_session_id: input.askingSessionId,
          user_agent: input.userAgent,
          expires_at: input.expiresAt,
        })
      );
    },
    async get(subject, id) {
      const key = idOf(id);
      const row = tables.first(TABLE, (r) => r.id === key && r.subject === subject);
      return row ? deviceKeyRequestFromRow(row) : null;
    },
    async recordMiss(id, attempts, deniedAt) {
      const key = idOf(id);
      tables.update(
        TABLE,
        (r) => r.id === key,
        deniedAt ? { attempts, denied_at: deniedAt } : { attempts }
      );
    },
    async consume(id, at) {
      const key = idOf(id);
      tables.update(TABLE, (r) => r.id === key, { sealed_key: null, consumed_at: at });
    },
    async seal(id, sealedKey, approvedBySessionId, now) {
      const key = idOf(id);
      return tables.update(
        TABLE,
        (r) =>
          r.id === key &&
          r.sealed_key === null &&
          r.denied_at === null &&
          r.expires_at.getTime() > now.getTime(),
        { sealed_key: sealedKey, approved_by_session_id: approvedBySessionId }
      ).length;
    },
    async deny(subject, id, at) {
      const key = idOf(id);
      return tables.update(
        TABLE,
        (r) => r.id === key && r.subject === subject && r.denied_at === null,
        { denied_at: at, sealed_key: null }
      ).length;
    },
  };
}
