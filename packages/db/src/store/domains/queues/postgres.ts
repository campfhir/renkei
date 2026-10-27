import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type {
  QueueClaimOptions,
  QueueClaimedRecord,
  QueueDeadLetterRecord,
  QueueStore,
  QueueTable,
} from './types';

/** A queue table name: a code constant from QueueTable, never input, so it is interpolated raw. */
const live = (table: QueueTable) => sql.raw(table);
/** Its dead-letter twin, the same trust rule. */
const dead = (table: QueueTable) => sql.raw(`${table}_dead_letters`);
/** A count of minutes or seconds for an INTERVAL literal; Number() keeps it a numeral. */
const whole = (n: number) => sql.raw(String(Number(n)));

// WHERE fragments shared by the claim and the fair source pick. `due` is
// the lease/backoff eligibility; the ordering-key gate lives only in the
// claim itself (the pick tolerates the approximation — see claim()).
const due = (options: QueueClaimOptions) => sql`
    ((c.status = 'pending' AND c.run_after <= NOW())
       OR (c.status = 'processing' AND c.locked_at < NOW() - INTERVAL '${whole(options.staleClaimMinutes)} minutes'))`;
const sourceRestriction = (options: QueueClaimOptions) =>
  options.sources && options.sources.length > 0
    ? sql` AND c.source IN (${sql.join(options.sources.map((s) => sql`${s}`))})`
    : sql``;

async function claimOne(
  db: Kysely<DB>,
  table: QueueTable,
  options: QueueClaimOptions,
  pinnedSource: string | null
): Promise<QueueClaimedRecord | null> {
  const result = await sql<QueueClaimedRecord>`
      UPDATE ${live(table)}
      SET status = 'processing', locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
        SELECT c.id FROM ${live(table)} c
        WHERE ${due(options)}
          ${sourceRestriction(options)}
          ${pinnedSource === null ? sql`` : sql`AND c.source = ${pinnedSource}`}
          AND (c.ordering_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM ${live(table)} b
            WHERE b.ordering_key = c.ordering_key
              AND b.status IN ('pending', 'processing')
              AND (b.created_at, b.id) < (c.created_at, c.id)
          ))
        ORDER BY c.created_at, c.id
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING id, source, type, payload, attempts
    `.execute(db);
  return result.rows[0] ?? null;
}

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

    async claim(table, options) {
      const conn = db();
      if (options.fairAcrossSources) {
        // Uniform pick among sources with due work. Due, not deliverable:
        // the ordering-key gate is skipped here on purpose — it would make
        // the pick as expensive as the claim. The cost of the approximation
        // is a pick that lands on a source whose head is key-blocked; the
        // oldest-first fallback below covers exactly that.
        const picked = await sql<{ source: string }>`
          SELECT source FROM (
            SELECT DISTINCT c.source FROM ${live(table)} c
            WHERE ${due(options)}
              ${sourceRestriction(options)}
          ) candidates
          ORDER BY random()
          LIMIT 1
        `.execute(conn);
        const source = picked.rows[0]?.source;
        // No due rows at all — deliverable is a subset of due, so done.
        if (source === undefined) return null;
        const claimed = await claimOne(conn, table, options, source);
        if (claimed) return claimed;
      }
      return claimOne(conn, table, options, null);
    },

    async complete(table, id, outcome, options = {}) {
      // 'skipped' is terminal exactly like 'processed' — the claim query
      // only ever looks at pending/processing — it differs only in what the
      // row tells an operator afterwards.
      if (options.clearPayload) {
        await sql`
          UPDATE ${live(table)}
          SET status = ${outcome}, locked_at = NULL, payload = '{}'::jsonb, updated_at = NOW()
          WHERE id = ${id}
        `.execute(db());
      } else {
        await sql`
          UPDATE ${live(table)}
          SET status = ${outcome}, locked_at = NULL, updated_at = NOW()
          WHERE id = ${id}
        `.execute(db());
      }
    },

    async release(table, id, attempts) {
      // `attempts = …` guards the release the same way the lease does: a
      // row another consumer has since reclaimed carries a higher count and
      // is not ours to give back.
      await sql`
        UPDATE ${live(table)}
        SET status = 'pending', locked_at = NULL, attempts = GREATEST(attempts - 1, 0),
            run_after = NOW(), updated_at = NOW()
        WHERE id = ${id} AND status = 'processing' AND attempts = ${attempts}
      `.execute(db());
    },

    async retry(table, id, error, delaySeconds) {
      await sql`
        UPDATE ${live(table)}
        SET status = 'pending', locked_at = NULL, last_error = ${error},
            run_after = NOW() + INTERVAL '${whole(delaySeconds)} seconds',
            updated_at = NOW()
        WHERE id = ${id}
      `.execute(db());
    },

    async deadLetter(table, id, error) {
      // MOVE to the dead-letter table atomically; the live table keeps no
      // trace, so its claim path stays lean and its ordering keys unblock.
      await sql`
        WITH moved AS (
          DELETE FROM ${live(table)} WHERE id = ${id}
          RETURNING id, source, type, payload, ordering_key, attempts, created_at
        )
        INSERT INTO ${dead(table)}
          (id, source, type, payload, ordering_key, attempts, last_error, created_at)
        SELECT id, source, type, payload, ordering_key, attempts, ${error}, created_at
        FROM moved
      `.execute(db());
    },

    async find(table, id) {
      const result = await sql<{
        id: string;
        source: string;
        type: string;
        payload: QueueClaimedRecord['payload'];
        ordering_key: string | null;
        status: string;
        attempts: number;
        run_after: Date;
        locked_at: Date | null;
        last_error: string | null;
        created_at: Date;
      }>`
        SELECT id, source, type, payload, ordering_key, status, attempts, run_after,
               locked_at, last_error, created_at
          FROM ${live(table)}
         WHERE id = ${id}
      `.execute(db());
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
        status: row.status,
        attempts: row.attempts,
        runAfter: row.run_after,
        lockedAt: row.locked_at,
        lastError: row.last_error,
        createdAt: row.created_at,
      };
    },

    async listDeadLetters(table, limit) {
      const result = await sql<{
        id: string;
        source: string;
        type: string;
        payload: QueueDeadLetterRecord['payload'];
        ordering_key: string | null;
        attempts: number;
        last_error: string | null;
        dead_at: Date;
      }>`
        SELECT id, source, type, payload, ordering_key, attempts, last_error, dead_at
        FROM ${dead(table)}
        ORDER BY dead_at DESC, id DESC
        LIMIT ${limit}
      `.execute(db());
      return result.rows.map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        payload: row.payload,
        orderingKey: row.ordering_key,
        attempts: row.attempts,
        lastError: row.last_error,
        deadAt: row.dead_at,
      }));
    },

    async requeueDeadLetters(table, ids) {
      if (ids.length === 0) return 0;
      // Fresh attempt budget, original enqueue order restored via the
      // preserved created_at, so requeued messages slot back into their
      // ordering keys where they left off.
      const result = await sql`
        WITH moved AS (
          DELETE FROM ${dead(table)} WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})
          RETURNING id, source, type, payload, ordering_key, created_at
        )
        INSERT INTO ${live(table)}
          (id, source, type, payload, ordering_key, status, attempts, run_after, created_at)
        SELECT id, source, type, payload, ordering_key, 'pending', 0, NOW(), created_at
        FROM moved
      `.execute(db());
      return Number(result.numAffectedRows ?? 0);
    },

    async purgeDeadLetters(table, ids) {
      if (ids.length === 0) return 0;
      const result = await sql`
        DELETE FROM ${dead(table)} WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})
      `.execute(db());
      return Number(result.numAffectedRows ?? 0);
    },
  };
}
