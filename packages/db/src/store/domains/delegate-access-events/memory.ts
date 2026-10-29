import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { DelegateAccessEventStore } from './types';

export function memoryDelegateAccessEvents(tables: MemoryTables): DelegateAccessEventStore {
  return {
    async record(event) {
      tables.insert('delegate_access_events', {
        caller: event.caller,
        op: event.op,
        subject_hash: event.subjectHash,
        target: event.target,
        outcome: event.outcome,
        status: event.status,
        id: globalThis.crypto.randomUUID(),
        created_at: new Date(),
      });
    },
    async recent(limit) {
      const rows = orderBy(
        tables.select('delegate_access_events'),
        [(r) => r.created_at, 'desc'],
        [(r) => r.id, 'desc']
      );
      return page(rows, limit).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        caller: row.caller,
        op: row.op,
        subjectHash: row.subject_hash,
        target: row.target,
        outcome: row.outcome,
        status: row.status,
      }));
    },
  };
}
