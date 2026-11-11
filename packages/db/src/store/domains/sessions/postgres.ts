import { sql, type Kysely } from 'kysely';
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
        .select(['id', 'subject', 'roles', 'expires_at', 'created_at', 'last_used_at'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        subject: row.subject,
        roles: row.roles,
        expiresAt: new Date(row.expires_at),
        createdAt: new Date(row.created_at),
        lastUsedAt: new Date(row.last_used_at),
      };
    },
    async touch(id, at) {
      await db().updateTable('sessions').set({ last_used_at: at }).where('id', '=', id).execute();
    },
    async delete(id) {
      await db().deleteFrom('sessions').where('id', '=', id).execute();
    },
    async lastUsedBySubject() {
      const rows = await db()
        .selectFrom('sessions')
        .select(['subject', sql<Date>`max(last_used_at)`.as('last_used_at')])
        .groupBy('subject')
        .orderBy('subject')
        .execute();
      return rows.map((row) => ({ subject: row.subject, lastUsedAt: new Date(row.last_used_at) }));
    },
    async lastUsedOf(subject) {
      const row = await db()
        .selectFrom('sessions')
        .select(sql<Date | null>`max(last_used_at)`.as('last_used_at'))
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row?.last_used_at ? new Date(row.last_used_at) : null;
    },
    async latestRolesOf(subject) {
      const row = await db()
        .selectFrom('sessions')
        .select('roles')
        .where('subject', '=', subject)
        .orderBy('last_used_at', 'desc')
        .orderBy('id')
        .limit(1)
        .executeTakeFirst();
      return row ? row.roles : null;
    },
    async deleteForSubject(subject) {
      const result = await db()
        .deleteFrom('sessions')
        .where('subject', '=', subject)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async revokeAll(subject) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const sessions = await trx
            .deleteFrom('sessions')
            .where('subject', '=', subject)
            .executeTakeFirst();
          const accessTokens = await trx
            .deleteFrom('oauth_access_tokens')
            .where('subject', '=', subject)
            .executeTakeFirst();
          const refreshTokens = await trx
            .deleteFrom('oauth_refresh_tokens')
            .where('subject', '=', subject)
            .executeTakeFirst();
          return {
            sessions: Number(sessions.numDeletedRows),
            accessTokens: Number(accessTokens.numDeletedRows),
            refreshTokens: Number(refreshTokens.numDeletedRows),
          };
        });
    },
  };
}
