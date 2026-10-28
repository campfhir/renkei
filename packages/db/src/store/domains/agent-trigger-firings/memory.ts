import { orderBy, page } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { AgentTriggerFiringStore } from './types';

const DAY_MS = 24 * 60 * 60_000;

export function memoryAgentTriggerFirings(tables: MemoryTables): AgentTriggerFiringStore {
  const matches = (triggerId: string, dedupeKey: string) => {
    const id = triggerId;
    return (r: { trigger_id: string; dedupe_key: string }) =>
      r.trigger_id === id && r.dedupe_key === dedupeKey;
  };
  return {
    async claim(triggerId, dedupeKey) {
      const inserted = tables.upsert(
        'agent_trigger_firings',
        { trigger_id: triggerId, dedupe_key: dedupeKey, run_id: null, created_at: new Date() },
        ['trigger_id', 'dedupe_key']
      );
      return inserted !== undefined;
    },
    async setRun(triggerId, dedupeKey, runId) {
      tables.update('agent_trigger_firings', matches(triggerId, dedupeKey), { run_id: runId });
    },
    async release(triggerId, dedupeKey) {
      tables.delete('agent_trigger_firings', matches(triggerId, dedupeKey));
    },
    async find(triggerId, dedupeKey) {
      const row = tables.first('agent_trigger_firings', matches(triggerId, dedupeKey));
      return row
        ? {
            triggerId: row.trigger_id,
            dedupeKey: row.dedupe_key,
            runId: row.run_id,
            createdAt: new Date(row.created_at),
          }
        : null;
    },
    async pruneOlderThan(days, limit) {
      const cutoff = Date.now() - days * DAY_MS;
      const doomed = page(
        orderBy(
          tables.select('agent_trigger_firings', (r) => r.created_at.getTime() < cutoff),
          [(r) => r.created_at],
          [(r) => r.trigger_id],
          [(r) => r.dedupe_key]
        ),
        limit
      );
      const keys = new Set(doomed.map((r) => JSON.stringify([r.trigger_id, r.dedupe_key])));
      return tables.delete('agent_trigger_firings', (r) =>
        keys.has(JSON.stringify([r.trigger_id, r.dedupe_key]))
      ).length;
    },
  };
}
