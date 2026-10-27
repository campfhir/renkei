import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { uploadSlotFromRow } from './record';
import type { UploadSlotStore } from './types';

export function memoryUploadSlots(tables: MemoryTables): UploadSlotStore {
  const slotId = (value: string) => tables.param('upload_slots', 'id', value);
  return {
    async create(input) {
      tables.insert('upload_slots', {
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
      });
    },
    async get(id) {
      const wanted = slotId(id);
      const row = tables.first('upload_slots', (r) => r.id === wanted);
      return row ? uploadSlotFromRow(row) : null;
    },
    async claim(id, proof) {
      const wanted = slotId(id);
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
      const wanted = slotId(id);
      tables.update('upload_slots', (r) => r.id === wanted, {
        status: outcome.ok ? 'completed' : 'failed',
        result: outcome.detail,
        completed_at: new Date(),
      });
    },
    async setDestination(id, destination) {
      const wanted = slotId(id);
      tables.update('upload_slots', (r) => r.id === wanted, {
        destination: JSON.stringify(destination),
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
