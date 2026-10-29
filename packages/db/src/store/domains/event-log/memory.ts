import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { EventLogStore } from './types';

export function memoryEventLog(tables: MemoryTables): EventLogStore {
  return {
    async listRecent(limit) {
      const rows = orderBy(
        tables.select('events'),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      return page(rows, limit).map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        payload: row.payload,
        createdAt: row.created_at,
      }));
    },
    async listRecentDeadLetters(limit) {
      const rows = orderBy(
        tables.select('events_dead_letters'),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      return page(rows, limit).map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        status: 'failed',
        attempts: row.attempts,
        payload: row.payload,
        createdAt: row.created_at,
      }));
    },
  };
}
