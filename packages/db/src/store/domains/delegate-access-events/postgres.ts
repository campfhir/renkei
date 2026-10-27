import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { DelegateAccessEventStore } from './types';

export function postgresDelegateAccessEvents(db: () => Kysely<DB>): DelegateAccessEventStore {
  return {
    async record(event) {
      await db()
        .insertInto('delegate_access_events')
        .values({
          caller: event.caller,
          op: event.op,
          subject_hash: event.subjectHash,
          target: event.target,
          outcome: event.outcome,
          status: event.status,
        })
        .execute();
    },
    async recent(limit) {
      const rows = await db()
        .selectFrom('delegate_access_events')
        .select(['id', 'created_at', 'caller', 'op', 'subject_hash', 'target', 'outcome', 'status'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        caller: row.caller,
        op: row.op,
        subjectHash: row.subject_hash,
        target: row.target,
        outcome: row.outcome,
        status: row.status,
      }));
    },
  };
}
