import type { MemoryTables } from '../../memory/tables';
import { dirtyWindowFromRow } from './postgres';
import type { WebexDirtyWindowStore } from './types';

export function memoryWebexDirtyWindows(tables: MemoryTables): WebexDirtyWindowStore {
  return {
    async markDirty(roomId, day, subject) {
      const now = new Date();
      tables.upsert(
        'webex_dirty_windows',
        { room_id: roomId, day, subject, marked_at: now },
        ['room_id', 'day'],
        (existing) => ({ marked_at: now, subject: subject ?? existing.subject })
      );
    },
    async find(roomId, day) {
      const row = tables.first('webex_dirty_windows', (r) => r.room_id === roomId && r.day === day);
      return row ? dirtyWindowFromRow(row) : null;
    },
  };
}
