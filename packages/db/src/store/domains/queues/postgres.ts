import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { QueueStore, QueueTable } from './types';

/** A queue table name: a code constant from QueueTable, never input, so it is interpolated raw. */
const live = (table: QueueTable) => sql.raw(table);

export function postgresQueues(db: () => Kysely<DB>): QueueStore {
  return {
    async enqueue(table, message) {
      const key = message.orderingKey ?? null;
      if (message.coalesce && key !== null) {
        // INSERT ... SELECT ... WHERE NOT EXISTS keeps the check and the
        // insert in one statement; two producers racing can still both
        // insert, which costs one redundant round, never a lost one.
        await sql`
          INSERT INTO ${live(table)} (id, source, type, payload, ordering_key)
          SELECT gen_random_uuid(), ${message.source}, ${message.type},
                 ${JSON.stringify(message.payload)}::jsonb, ${key}
          WHERE NOT EXISTS (
            SELECT 1 FROM ${live(table)} q
            WHERE q.source = ${message.source}
              AND q.type = ${message.type}
              AND q.ordering_key = ${key}
              AND q.status = 'pending'
          )
        `.execute(db());
        return;
      }
      await sql`
        INSERT INTO ${live(table)} (id, source, type, payload, ordering_key)
        VALUES (gen_random_uuid(), ${message.source}, ${message.type},
                ${JSON.stringify(message.payload)}::jsonb, ${key})
      `.execute(db());
    },
    async discardPending(table, type, match) {
      if (match.length === 0) throw new Error('discardPending needs a predicate');
      // `#>>` walks a path and compares as text, so one form covers both a
      // top-level key and a nested one. Values are bound, never interpolated.
      const predicates = match.map(
        (entry) => sql`payload #>> ${sql.val([...entry.path])} = ${entry.value}`
      );
      const result = await sql`
        DELETE FROM ${live(table)}
         WHERE type = ${type}
           -- Pending only: a claimed message is being worked right now.
           AND status = 'pending'
           AND ${sql.join(predicates, sql` AND `)}
      `.execute(db());
      return Number(result.numAffectedRows ?? 0);
    },
    async listPending(table) {
      const result = await sql<{
        source: string;
        type: string;
        payload: unknown;
        ordering_key: string | null;
      }>`
        SELECT source, type, payload, ordering_key FROM ${live(table)}
         WHERE status = 'pending'
         ORDER BY created_at, id
      `.execute(db());
      return result.rows.map((row) => ({
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
      }));
    },
    async discardAgentRunJobs(runId) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const skipped = await trx
            .updateTable('agent_jobs')
            .set({ status: 'skipped', locked_at: null, updated_at: sql`NOW()` })
            .where('status', 'in', ['pending', 'processing'])
            .where(sql<string>`payload->>'runId'`, '=', runId)
            .executeTakeFirst();
          const dead = await trx
            .deleteFrom('agent_jobs_dead_letters')
            .where(sql<string>`payload->>'runId'`, '=', runId)
            .executeTakeFirst();
          return {
            skipped: Number(skipped.numUpdatedRows ?? 0),
            deadLetters: Number(dead.numDeletedRows ?? 0),
          };
        });
    },
  };
}
