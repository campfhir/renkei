import { orderBy, page } from '../../memory/order';
import { toJson, uniqueViolation, type MemoryTables } from '../../memory/tables';
import { uploadSlotFromRow } from './record';
import type { UploadSlotStore } from './types';

export function memoryUploadSlots(tables: MemoryTables): UploadSlotStore {
  return {
    async create(input) {
      // A slot is minted once: a second one with the same id or bearer is refused.
      if (
        tables.first('upload_slots', (r) => r.id === input.id || r.token_hash === input.tokenHash)
      ) {
        throw uniqueViolation('upload_slots', 'upload_slots_token_hash_key');
      }
      tables.insert('upload_slots', {
        id: input.id,
        token_hash: input.tokenHash,
        subject: input.subject,
        account_id: input.accountId,
        kind: input.kind,
        destination: toJson(input.destination),
        filename: input.filename,
        content_type: input.contentType,
        max_bytes: input.maxBytes,
        expires_at: input.expiresAt,
        status: 'pending',
        result: null,
        completed_at: null,
        created_at: new Date(),
      });
    },
    async get(id) {
      const wanted = id;
      const row = tables.first('upload_slots', (r) => r.id === wanted);
      return row ? uploadSlotFromRow(row) : null;
    },
    async claim(id, proof) {
      const wanted = id;
      const now = new Date();
      const [row] = tables.update(
        'upload_slots',
        (r) =>
          r.id === wanted &&
          r.status === 'pending' &&
          r.expires_at.getTime() > now.getTime() &&
          ('tokenHash' in proof ? r.token_hash === proof.tokenHash : r.subject === proof.subject),
        { status: 'completed', completed_at: now }
      );
      return row ? uploadSlotFromRow(row) : null;
    },
    async finish(id, outcome) {
      const wanted = id;
      tables.update('upload_slots', (r) => r.id === wanted, {
        status: outcome.ok ? 'completed' : 'failed',
        result: outcome.detail,
        completed_at: new Date(),
      });
    },
    async setDestination(id, destination) {
      const wanted = id;
      tables.update('upload_slots', (r) => r.id === wanted, {
        destination: toJson(destination),
      });
    },
    async expireStale() {
      const now = Date.now();
      return tables.update(
        'upload_slots',
        (r) => r.status === 'pending' && r.expires_at.getTime() < now,
        { status: 'expired' }
      ).length;
    },
    async pruneSettled(days, limit) {
      const cutoff = Date.now() - days * 24 * 60 * 60_000;
      const doomed = new Set(
        page(
          orderBy(
            tables.select(
              'upload_slots',
              (r) =>
                ['completed', 'failed', 'expired'].includes(r.status) &&
                r.created_at.getTime() < cutoff
            ),
            [(r) => r.created_at],
            [(r) => r.id]
          ),
          limit
        ).map((r) => r.id)
      );
      return tables.delete('upload_slots', (r) => doomed.has(r.id)).length;
    },
  };
}
