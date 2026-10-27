import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { IdentityRecord, IdentityStore } from './types';

const COLUMNS = ['subject', 'email', 'display_name', 'idp_groups'] as const;

function record(row: {
  subject: string;
  email: string;
  display_name: string | null;
  idp_groups: string[] | null;
}): IdentityRecord {
  return {
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    idpGroups: row.idp_groups ?? [],
  };
}

export function postgresIdentities(db: () => Kysely<DB>): IdentityStore {
  return {
    async get(subject) {
      const row = await db()
        .selectFrom('identities')
        .select(COLUMNS)
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row ? record(row) : null;
    },
    async upsert({ subject, email, displayName, idpGroups }) {
      await db()
        .insertInto('identities')
        .values({ subject, email, display_name: displayName, idp_groups: idpGroups })
        .onConflict((oc) =>
          oc.columns(['subject']).doUpdateSet({
            email,
            display_name: displayName,
            idp_groups: idpGroups,
            updated_at: new Date().toISOString(),
          })
        )
        .execute();
    },
    async clearGroups(subject) {
      await db()
        .updateTable('identities')
        .set({ idp_groups: [], updated_at: new Date().toISOString() })
        .where('subject', '=', subject)
        .execute();
    },
    async list() {
      const rows = await db()
        .selectFrom('identities')
        .select(COLUMNS)
        .orderBy('display_name', 'asc')
        .orderBy('email', 'asc')
        .execute();
      return rows.map(record);
    },
    async listBySubjects(subjects) {
      const unique = [...new Set(subjects)];
      if (unique.length === 0) return [];
      const rows = await db()
        .selectFrom('identities')
        .select(COLUMNS)
        .where('subject', 'in', unique)
        .orderBy('subject')
        .execute();
      return rows.map(record);
    },
    async distinctGroups() {
      const result = await sql<{ value: string }>`
        SELECT DISTINCT unnest(idp_groups) AS value FROM identities ORDER BY value
      `.execute(db());
      return result.rows.map((row) => row.value);
    },
  };
}
