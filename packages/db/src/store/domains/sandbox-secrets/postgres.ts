import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { sandboxSecretFromRow, sandboxSecretValues } from './record';
import type { SandboxSecretStore } from './types';

export function postgresSandboxSecrets(db: () => Kysely<DB>): SandboxSecretStore {
  return {
    async insert(secret) {
      const row = await db()
        .insertInto('sandbox_secrets')
        .values(sandboxSecretValues(secret))
        .returningAll()
        .executeTakeFirstOrThrow();
      return sandboxSecretFromRow(row);
    },
    async list(subject) {
      const rows = await db()
        .selectFrom('sandbox_secrets')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('name')
        .execute();
      return rows.map(sandboxSecretFromRow);
    },
    async count(subject) {
      const row = await db()
        .selectFrom('sandbox_secrets')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row?.count ? Number(row.count) : 0;
    },
    async get(subject, id) {
      const row = await db()
        .selectFrom('sandbox_secrets')
        .selectAll()
        .where('subject', '=', subject)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? sandboxSecretFromRow(row) : null;
    },
    async getByName(subject, name) {
      const row = await db()
        .selectFrom('sandbox_secrets')
        .selectAll()
        .where('subject', '=', subject)
        .where('name', '=', name)
        .executeTakeFirst();
      return row ? sandboxSecretFromRow(row) : null;
    },
    async touchUsed(id, at) {
      await db()
        .updateTable('sandbox_secrets')
        .set({ last_used_at: at })
        .where('id', '=', id)
        .execute();
    },
    async delete(subject, id) {
      const row = await db()
        .deleteFrom('sandbox_secrets')
        .where('subject', '=', subject)
        .where('id', '=', id)
        .returning(['id', 'name'])
        .executeTakeFirst();
      return row ? { id: row.id, name: row.name } : null;
    },
    async listExpiredIds(before, limit) {
      const rows = await db()
        .selectFrom('sandbox_secrets')
        .select(['id'])
        .where('expires_at', '<', before)
        .orderBy('expires_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => row.id);
    },
    async deleteById(id) {
      await db().deleteFrom('sandbox_secrets').where('id', '=', id).execute();
    },
  };
}
