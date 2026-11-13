import type { Kysely, Selectable } from 'kysely';
import type { DB, SandboxArchives } from '../../../db.types';
import type { SandboxArchiveRecord, SandboxArchiveStore } from './types';

function recordOf(row: Selectable<SandboxArchives>): SandboxArchiveRecord {
  return {
    routeKey: row.route_key,
    sandboxId: row.sandbox_id,
    blobKey: row.blob_key,
    // int8 arrives as a string.
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
  };
}

export function postgresSandboxArchives(db: () => Kysely<DB>): SandboxArchiveStore {
  return {
    async get(routeKey) {
      const row = await db()
        .selectFrom('sandbox_archives')
        .selectAll()
        .where('route_key', '=', routeKey)
        .executeTakeFirst();
      return row ? recordOf(row) : null;
    },
    async put(archive) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const previous = await trx
            .deleteFrom('sandbox_archives')
            .where('route_key', '=', archive.routeKey)
            .returningAll()
            .executeTakeFirst();
          await trx
            .insertInto('sandbox_archives')
            .values({
              route_key: archive.routeKey,
              sandbox_id: archive.sandboxId,
              blob_key: archive.blobKey,
              size_bytes: String(archive.sizeBytes),
              created_at: archive.createdAt,
            })
            .execute();
          return previous ? recordOf(previous) : null;
        });
    },
    async remove(routeKey) {
      const row = await db()
        .deleteFrom('sandbox_archives')
        .where('route_key', '=', routeKey)
        .returningAll()
        .executeTakeFirst();
      return row ? recordOf(row) : null;
    },
    async listOlderThan(before, limit) {
      const rows = await db()
        .selectFrom('sandbox_archives')
        .selectAll()
        .where('created_at', '<', before)
        .orderBy('created_at', 'asc')
        .orderBy('route_key', 'asc')
        .limit(limit)
        .execute();
      return rows.map(recordOf);
    },
  };
}
