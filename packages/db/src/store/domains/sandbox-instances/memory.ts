import type { MemoryTables } from '../../memory/tables';
import type { SandboxInstanceStore } from './types';

export function memorySandboxInstances(tables: MemoryTables): SandboxInstanceStore {
  return {
    async heartbeat(instance) {
      const row = {
        id: instance.id,
        address: instance.address,
        started_at: instance.startedAt,
        last_seen_at: instance.at,
      };
      tables.upsert('sandbox_instances', row, ['id'], row);
    },
    async removeUnseenSince(before) {
      return tables.delete('sandbox_instances', (r) => r.last_seen_at.getTime() < before.getTime())
        .length;
    },
    async listLive(since) {
      return tables
        .select('sandbox_instances', (r) => r.last_seen_at.getTime() >= since.getTime())
        .map((row) => ({
          id: row.id,
          address: row.address,
          startedAt: row.started_at,
          lastSeenAt: row.last_seen_at,
          assigned: tables.select('sandbox_assignments', (a) => a.instance_id === row.id).length,
        }))
        .sort((a, b) => a.assigned - b.assigned || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async assignment(subject) {
      const wanted = subject;
      const row = tables.first('sandbox_assignments', (r) => r.subject === wanted);
      if (!row) return null;
      const instance = tables.first('sandbox_instances', (r) => r.id === row.instance_id);
      return {
        subject: row.subject,
        instanceId: row.instance_id,
        assignedAt: row.assigned_at,
        instance: instance
          ? {
              id: instance.id,
              address: instance.address,
              startedAt: instance.started_at,
              lastSeenAt: instance.last_seen_at,
            }
          : null,
      };
    },
    async assign(input) {
      const wanted = input.subject;
      const existing = tables.first('sandbox_assignments', (r) => r.subject === wanted);
      if (input.replacing === null) {
        if (!existing) {
          tables.insert('sandbox_assignments', {
            subject: input.subject,
            instance_id: input.instanceId,
            assigned_at: input.at,
          });
        }
      } else {
        tables.update(
          'sandbox_assignments',
          (r) => r.subject === wanted && r.instance_id === input.replacing,
          { instance_id: input.instanceId, assigned_at: input.at }
        );
      }
      return (
        tables.first('sandbox_assignments', (r) => r.subject === wanted)?.instance_id ??
        input.instanceId
      );
    },
  };
}
