import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { QueueStore } from './types';

/** `payload #>> path`: the value at the path as text, null where the path leads nowhere. */
function textAt(payload: unknown, path: readonly string[]): string | null {
  let current: unknown = payload;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^-?\d+$/.test(segment)) return null;
      const index = Number(segment);
      current = current[index < 0 ? current.length + index : index];
    } else if (typeof current === 'object' && current !== null) {
      current = Reflect.get(current, segment);
    } else return null;
    if (current === undefined) return null;
  }
  if (current === null) return null;
  return typeof current === 'string' ? current : JSON.stringify(current);
}

export function memoryQueues(tables: MemoryTables): QueueStore {
  return {
    async enqueue(table, message) {
      const key = message.orderingKey ?? null;
      if (message.coalesce && key !== null) {
        const waiting = tables.first(
          table,
          (r) =>
            r.source === message.source &&
            r.type === message.type &&
            r.ordering_key === key &&
            r.status === 'pending'
        );
        if (waiting) return;
      }
      tables.insert(table, {
        id: globalThis.crypto.randomUUID(),
        source: message.source,
        type: message.type,
        payload: JSON.stringify(message.payload),
        ordering_key: key,
      });
    },
    async discardPending(table, type, match) {
      if (match.length === 0) throw new Error('discardPending needs a predicate');
      return tables.delete(
        table,
        (r) =>
          r.type === type &&
          r.status === 'pending' &&
          match.every((entry) => textAt(r.payload, entry.path) === entry.value)
      ).length;
    },
    async listPending(table) {
      const rows = tables.select(table, (r) => r.status === 'pending');
      return orderBy(rows, [(r) => r.created_at], [(r) => r.id]).map((row) => ({
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
      }));
    },
    async discardAgentRunJobs(runId) {
      const ofRun = (payload: unknown) => textAt(payload, ['runId']) === runId;
      const skipped = tables.update(
        'agent_jobs',
        (r) => (r.status === 'pending' || r.status === 'processing') && ofRun(r.payload),
        { status: 'skipped', locked_at: null, updated_at: new Date() }
      ).length;
      const deadLetters = tables.delete('agent_jobs_dead_letters', (r) => ofRun(r.payload)).length;
      return { skipped, deadLetters };
    },
  };
}
