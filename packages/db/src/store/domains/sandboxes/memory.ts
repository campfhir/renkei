import type { MemoryTables } from '../../memory/tables';
import { orderBy } from '../../memory/order';
import { sandboxRecordOf } from './record';
import type { SandboxStore } from './types';

export function memorySandboxes(tables: MemoryTables): SandboxStore {
  return {
    async claim(input) {
      // One sandbox that is not deleted per scope: the caller reads the other one.
      const taken = tables.first(
        'sandboxes',
        (r) => r.route_key === input.routeKey && r.state !== 'deleted'
      );
      if (taken) return null;
      return sandboxRecordOf(
        tables.insert('sandboxes', {
          id: input.id,
          route_key: input.routeKey,
          kind: input.kind,
          provider: input.provider,
          provider_id: null,
          state: 'provisioning',
          address: null,
          error: null,
          created_at: input.at,
          last_active_at: input.at,
          state_changed_at: input.at,
          verified_at: input.at,
          subjects: [],
        })
      );
    },
    async live(routeKey) {
      const row = tables.first(
        'sandboxes',
        (r) => r.route_key === routeKey && r.state !== 'deleted'
      );
      return row ? sandboxRecordOf(row) : null;
    },
    async get(id) {
      const row = tables.first('sandboxes', (r) => r.id === id);
      return row ? sandboxRecordOf(row) : null;
    },
    async transition(input) {
      const moved = tables.update(
        'sandboxes',
        (r) => r.id === input.id && input.from.some((state) => state === r.state),
        {
          state: input.to,
          state_changed_at: input.at,
          verified_at: input.at,
          ...(input.providerId !== undefined ? { provider_id: input.providerId } : {}),
          ...(input.address !== undefined ? { address: input.address } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        }
      );
      return moved.length > 0;
    },
    async touch(id, at) {
      tables.update('sandboxes', (r) => r.id === id && r.last_active_at.getTime() < at.getTime(), {
        last_active_at: at,
      });
    },
    async allowSubject(id, subject, limit) {
      const row = tables.first('sandboxes', (r) => r.id === id);
      if (!row) return false;
      if (row.subjects.includes(subject)) return true;
      if (row.subjects.length >= limit) return false;
      tables.update('sandboxes', (r) => r.id === id, { subjects: [...row.subjects, subject] });
      return true;
    },
    async verified(id, at) {
      tables.update('sandboxes', (r) => r.id === id, { verified_at: at });
    },
    async list(input) {
      const rows = tables.select(
        'sandboxes',
        (r) =>
          input.states.some((state) => state === r.state) &&
          (!input.lastActiveBefore ||
            r.last_active_at.getTime() < input.lastActiveBefore.getTime()) &&
          (!input.stateChangedBefore ||
            r.state_changed_at.getTime() < input.stateChangedBefore.getTime())
      );
      return orderBy(rows, [(r) => r.last_active_at], [(r) => r.id])
        .slice(0, input.limit)
        .map(sandboxRecordOf);
    },
    async purgeDeleted(before) {
      return tables.delete(
        'sandboxes',
        (r) => r.state === 'deleted' && r.state_changed_at.getTime() < before.getTime()
      ).length;
    },
  };
}
