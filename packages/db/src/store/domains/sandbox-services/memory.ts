import { orderBy, page } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { sandboxServiceFromRow, sandboxServicePatch, sandboxServiceValues } from './record';
import type { SandboxServiceStore } from './types';

export function memorySandboxServices(tables: MemoryTables): SandboxServiceStore {
  return {
    async insert(service) {
      return sandboxServiceFromRow(
        tables.insert('sandbox_services', {
          ...sandboxServiceValues(service),
          exports: toJson(service.exports),
          ports: [],
          container_id: null,
          host: null,
          error: null,
          last_used_at: new Date(),
          created_at: new Date(),
        })
      );
    },
    async list(subject) {
      const rows = tables.select('sandbox_services', (r) => r.subject === subject);
      return orderBy(rows, [(r) => r.name]).map(sandboxServiceFromRow);
    },
    async getByName(subject, name) {
      const row = tables.first('sandbox_services', (r) => r.subject === subject && r.name === name);
      return row ? sandboxServiceFromRow(row) : null;
    },
    async update(serviceId, change) {
      const wanted = serviceId;
      tables.update('sandbox_services', (r) => r.id === wanted, {
        ...sandboxServicePatch(change),
        ...(change.ports !== undefined ? { ports: toJson(change.ports) } : {}),
      });
    },
    async touch(ids, change) {
      const wanted = new Set(ids);
      tables.update('sandbox_services', (r) => wanted.has(r.id), {
        last_used_at: change.lastUsedAt,
        expires_at: change.expiresAt,
      });
    },
    async deleteById(serviceId) {
      const wanted = serviceId;
      tables.delete('sandbox_services', (r) => r.id === wanted);
    },
    async listExpired(before, limit) {
      const rows = tables.select(
        'sandbox_services',
        (r) => r.expires_at.getTime() < before.getTime()
      );
      return page(orderBy(rows, [(r) => r.expires_at], [(r) => r.id]), limit).map(
        sandboxServiceFromRow
      );
    },
    async listClaimedContainerIds() {
      const rows = tables.select('sandbox_services', (r) => r.container_id !== null);
      return orderBy(rows, [(r) => r.container_id]).flatMap((row) =>
        row.container_id === null ? [] : [row.container_id]
      );
    },
  };
}
