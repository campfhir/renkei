import type { MemoryTables, Row } from '../../memory/tables';
import { orderBy } from '../../memory/order';
import type { SandboxArchiveRecord, SandboxArchiveStore } from './types';

function recordOf(row: Row<'sandbox_archives'>): SandboxArchiveRecord {
  return {
    routeKey: row.route_key,
    sandboxId: row.sandbox_id,
    blobKey: row.blob_key,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
  };
}

export function memorySandboxArchives(tables: MemoryTables): SandboxArchiveStore {
  return {
    async get(routeKey) {
      const row = tables.first('sandbox_archives', (r) => r.route_key === routeKey);
      return row ? recordOf(row) : null;
    },
    async put(archive) {
      const [previous] = tables.delete('sandbox_archives', (r) => r.route_key === archive.routeKey);
      tables.insert('sandbox_archives', {
        route_key: archive.routeKey,
        sandbox_id: archive.sandboxId,
        blob_key: archive.blobKey,
        size_bytes: String(archive.sizeBytes),
        created_at: archive.createdAt,
      });
      return previous ? recordOf(previous) : null;
    },
    async remove(routeKey) {
      const [row] = tables.delete('sandbox_archives', (r) => r.route_key === routeKey);
      return row ? recordOf(row) : null;
    },
    async listOlderThan(before, limit) {
      const rows = tables.select(
        'sandbox_archives',
        (r) => r.created_at.getTime() < before.getTime()
      );
      return orderBy(rows, [(r) => r.created_at], [(r) => r.route_key])
        .slice(0, limit)
        .map(recordOf);
    },
  };
}
