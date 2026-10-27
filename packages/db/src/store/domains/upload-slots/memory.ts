import type { MemoryTables } from '../../memory/tables';
import { uploadSlotFromRow, uploadSlotValues } from './postgres';
import type { UploadSlotStore } from './types';

export function memoryUploadSlots(tables: MemoryTables): UploadSlotStore {
  const idOf = (id: string) => tables.param('upload_slots', 'id', id);
  return {
    async create(slot) {
      tables.insert('upload_slots', uploadSlotValues(slot));
    },
    async get(id) {
      const key = idOf(id);
      const row = tables.first('upload_slots', (r) => r.id === key);
      return row ? uploadSlotFromRow(row) : null;
    },
    async claimPendingByOwner(id, subject, now) {
      const key = idOf(id);
      const [row] = tables.update(
        'upload_slots',
        (r) =>
          r.id === key &&
          r.subject === subject &&
          r.status === 'pending' &&
          r.expires_at.getTime() > now.getTime(),
        { status: 'completed', completed_at: now }
      );
      return row ? uploadSlotFromRow(row) : null;
    },
  };
}
