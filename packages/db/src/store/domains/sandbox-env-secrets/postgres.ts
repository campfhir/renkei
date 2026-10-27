import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { envSecretFromRow } from './record';
import type { SandboxEnvSecretStore } from './types';

export function postgresSandboxEnvSecrets(db: () => Kysely<DB>): SandboxEnvSecretStore {
  return {
    async upsert(secret) {
      const row = await db()
        .insertInto('sandbox_env_secrets')
        .values({
          id: secret.id,
          subject: secret.subject,
          name: secret.name,
          sealed: secret.sealed,
        })
        .onConflict((oc) =>
          oc.columns(['subject', 'name']).doUpdateSet({
            sealed: secret.sealed,
            updated_at: secret.updatedAt,
          })
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return envSecretFromRow(row);
    },
    async list(subject) {
      const rows = await db()
        .selectFrom('sandbox_env_secrets')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('name')
        .execute();
      return rows.map(envSecretFromRow);
    },
    async count(subject) {
      const row = await db()
        .selectFrom('sandbox_env_secrets')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row?.count ? Number(row.count) : 0;
    },
    async has(subject, name) {
      const row = await db()
        .selectFrom('sandbox_env_secrets')
        .select('id')
        .where('subject', '=', subject)
        .where('name', '=', name)
        .executeTakeFirst();
      return row !== undefined;
    },
    async listSealed(subject) {
      return db()
        .selectFrom('sandbox_env_secrets')
        .select(['id', 'name', 'sealed'])
        .where('subject', '=', subject)
        .orderBy('name')
        .execute();
    },
    async touchUsed(ids, at) {
      if (ids.length === 0) return;
      await db()
        .updateTable('sandbox_env_secrets')
        .set({ last_used_at: at })
        .where('id', 'in', ids)
        .execute();
    },
    async delete(subject, name) {
      const row = await db()
        .deleteFrom('sandbox_env_secrets')
        .where('subject', '=', subject)
        .where('name', '=', name)
        .returning(['id', 'name'])
        .executeTakeFirst();
      return row ? { id: row.id, name: row.name } : null;
    },
  };
}
