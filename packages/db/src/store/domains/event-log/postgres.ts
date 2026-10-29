import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { EventLogStore } from './types';

export function postgresEventLog(db: () => Kysely<DB>): EventLogStore {
  return {
    async listRecent(limit) {
      const rows = await db()
        .selectFrom('events')
        .select(['id', 'source', 'type', 'status', 'attempts', 'payload', 'created_at'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        status: row.status,
        attempts: row.attempts,
        payload: row.payload,
        createdAt: new Date(row.created_at),
      }));
    },
    async listRecentDeadLetters(limit) {
      const rows = await db()
        .selectFrom('events_dead_letters')
        .select(['id', 'source', 'type', 'attempts', 'payload', 'created_at'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        status: 'failed',
        attempts: row.attempts,
        payload: row.payload,
        createdAt: new Date(row.created_at),
      }));
    },
  };
}
