import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { sandboxServiceFromRow, sandboxServicePatch, sandboxServiceValues } from './record';
import type { SandboxServiceStore } from './types';

export function postgresSandboxServices(db: () => Kysely<DB>): SandboxServiceStore {
  return {
    async insert(service) {
      const row = await db()
        .insertInto('sandbox_services')
        .values(sandboxServiceValues(service))
        .returningAll()
        .executeTakeFirstOrThrow();
      return sandboxServiceFromRow(row);
    },
    async list(subject) {
      const rows = await db()
        .selectFrom('sandbox_services')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('name')
        .execute();
      return rows.map(sandboxServiceFromRow);
    },
    async getByName(subject, name) {
      const row = await db()
        .selectFrom('sandbox_services')
        .selectAll()
        .where('subject', '=', subject)
        .where('name', '=', name)
        .executeTakeFirst();
      return row ? sandboxServiceFromRow(row) : null;
    },
    async update(id, change) {
      const patch = sandboxServicePatch(change);
      // An UPDATE with nothing to SET is not valid SQL; nothing to change is a no-op.
      if (Object.keys(patch).length === 0) return;
      await db().updateTable('sandbox_services').set(patch).where('id', '=', id).execute();
    },
    async touch(ids, change) {
      if (ids.length === 0) return;
      await db()
        .updateTable('sandbox_services')
        .set({ last_used_at: change.lastUsedAt, expires_at: change.expiresAt })
        .where('id', 'in', ids)
        .execute();
    },
    async deleteById(id) {
      await db().deleteFrom('sandbox_services').where('id', '=', id).execute();
    },
    async listExpired(before, limit) {
      const rows = await db()
        .selectFrom('sandbox_services')
        .selectAll()
        .where('expires_at', '<', before)
        .orderBy('expires_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(sandboxServiceFromRow);
    },
    async listClaimedContainerIds() {
      const rows = await db()
        .selectFrom('sandbox_services')
        .select('container_id')
        .where('container_id', 'is not', null)
        .orderBy('container_id')
        .execute();
      return rows.flatMap((row) => (row.container_id === null ? [] : [row.container_id]));
    },
  };
}
