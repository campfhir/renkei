import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { SessionStore } from './types';

export function postgresSessions(db: () => Kysely<DB>): SessionStore {
  return {
    async create({ id, subject, roles, expiresAt }) {
      await db()
        .insertInto('sessions')
        .values({ id, subject, roles, expires_at: expiresAt })
        .execute();
    },
    async find(id) {
      const row = await db()
        .selectFrom('sessions')
        .select(['id', 'subject', 'roles', 'expires_at', 'last_used_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        subject: row.subject,
        roles: row.roles,
        expiresAt: new Date(row.expires_at),
        lastUsedAt: new Date(row.last_used_at),
      };
    },
    async touch(id, at) {
      await db().updateTable('sessions').set({ last_used_at: at }).where('id', '=', id).execute();
    },
    async delete(id) {
      await db().deleteFrom('sessions').where('id', '=', id).execute();
    },
  };
}
