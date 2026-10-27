import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { WebexDirtyWindowStore } from './types';

export function memoryWebexDirtyWindows(tables: MemoryTables): WebexDirtyWindowStore {
  return {
    async listQuiet(markedBefore, limit) {
      const cutoff = markedBefore.getTime();
      return page(
        orderBy(
          tables.select('webex_dirty_windows', (r) => r.marked_at.getTime() <= cutoff),
          [(r) => r.marked_at],
          [(r) => r.room_id],
          [(r) => r.day]
        ),
        limit
      ).map((row) => ({
        roomId: row.room_id,
        day: row.day,
        subject: row.subject,
        markedAt: new Date(row.marked_at),
      }));
    },
    async delete(roomId, day, options = {}) {
      const markedAt = options.markedAt;
      return tables.delete(
        'webex_dirty_windows',
        (r) =>
          r.room_id === roomId &&
          r.day === day &&
          (markedAt === undefined || r.marked_at.getTime() === markedAt.getTime())
      ).length;
    },
    async markIfAbsent(roomId, day, subject) {
      tables.upsert(
        'webex_dirty_windows',
        { room_id: roomId, day, subject, marked_at: new Date() },
        ['room_id', 'day']
      );
    },
  };
}
