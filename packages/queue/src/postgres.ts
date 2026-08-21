/**
 * The Postgres adapter: one queue = one table plus one dead-letter table
 * (migrations 013/030). Claims take row locks with FOR UPDATE SKIP LOCKED,
 * so any number of consumer instances compete safely without coordination —
 * horizontal scale is a `docker compose up --scale`, not a schema change.
 *
 * Ordering keys are enforced in the claim query: a message is deliverable
 * only when no older live message shares its key. Combined with SKIP
 * LOCKED, N workers drain distinct keys in parallel while each key's
 * messages stay strictly serial — the row-lock rendition of Kafka's
 * partition ordering.
 *
 * The claim query doubles as crash recovery: a `processing` row whose
 * `locked_at` is stale is a dead worker's orphan and is claimable again
 * (the delivery lease of the contract). Dead messages MOVE to the
 * dead-letter table in one CTE, so the live table's claim scan never pays
 * for history, and `requeue` moves them back with a fresh attempt budget.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type {
  QueuePurger,
  ClaimedMessage,
  CompletionOutcome,
  DeadLetter,
  DeadLetterStore,
  Disposition,
  Queue,
  QueueConsumer,
  QueueMessageInput,
  QueueProducer,
} from './contract';
import { failureDisposition, DEFAULT_RETRY_POLICY, type RetryPolicy } from './policy';

/** How long a claim may be held before it counts as abandoned. */
const DEFAULT_STALE_CLAIM_MINUTES = 10;

export interface PostgresQueueConfig {
  /** Live table name. A code constant, never user input — it is interpolated raw. */
  table: string;
  /** Dead-letter table name. Same trust rule as `table`. */
  deadLetterTable: string;
  policy?: RetryPolicy;
  staleClaimMinutes?: number;
  /**
   * Restrict this consumer to messages from these sources. Lets a worker
   * instance be fixated on the traffic it exists to serve (e.g. an
   * interactive worker on 'webex' only) while other instances drain the
   * rest. Consumer-side only; producers are unaffected.
   */
  sources?: readonly string[];
  /**
   * Claim evenly across sources instead of strictly oldest-first: each
   * claim picks a source uniformly at random among those with due work,
   * then takes that source's oldest deliverable message. With three
   * backlogged sources each gets ~a third of the consumer, so one chatty
   * source (a mailbox delta storm) cannot starve an interactive one (a
   * chat message awaiting a reply). Falls back to the plain oldest-first
   * claim when the picked source has nothing deliverable, so fairness
   * never idles a consumer while work exists.
   */
  fairAcrossSources?: boolean;
  /**
   * Blank payloads on completion. For queues whose messages carry full
   * document content (embedding jobs: a transcript can be tens of KB),
   * keeping payloads on every processed row would grow the table without
   * bound. Dead letters always keep their payload — they exist to be
   * inspected and requeued.
   */
  clearPayloadOnComplete?: boolean;
}

interface DeadLetterRow {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: DeadLetter['payload'];
  ordering_key: string | null;
  attempts: number;
  last_error: string | null;
  dead_at: Date;
}

export function createPostgresQueue(config: PostgresQueueConfig): Queue {
  // Identifier fragments are built lazily, per call: constructing a queue
  // must stay side-effect free so importing a module that wires one up
  // never touches the SQL layer (worker test suites stub kysely).
  const live = () => sql.raw(config.table);
  const dead = () => sql.raw(config.deadLetterTable);
  const policy = config.policy ?? DEFAULT_RETRY_POLICY;
  const staleMinutes = () =>
    sql.raw(String(config.staleClaimMinutes ?? DEFAULT_STALE_CLAIM_MINUTES));

  const producer: QueueProducer = {
    async enqueue(message: QueueMessageInput) {
      const dbResult = getDatabase();
      if (!dbResult.ok) return err('QUEUE_ERROR' as const, { message: 'database unavailable' });
      try {
        await sql`
          INSERT INTO ${live()} (id, tenant_id, source, type, payload, ordering_key)
          VALUES (gen_random_uuid(), ${message.tenantId}, ${message.source}, ${message.type},
                  ${JSON.stringify(message.payload)}::jsonb, ${message.orderingKey ?? null})
        `.execute(dbResult.val);
        return ok();
      } catch (error) {
        return err('QUEUE_ERROR' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  // WHERE fragments shared by the claim and the fair source pick. `due` is
  // the lease/backoff eligibility; the ordering-key gate lives only in the
  // claim itself (the pick tolerates the approximation — see claim()).
  const due = () => sql`
    ((c.status = 'pending' AND c.run_after <= NOW())
       OR (c.status = 'processing' AND c.locked_at < NOW() - INTERVAL '${staleMinutes()} minutes'))`;
  const sourceRestriction = () =>
    config.sources && config.sources.length > 0
      ? sql` AND c.source IN (${sql.join(config.sources.map((s) => sql`${s}`))})`
      : sql``;

  type Db = Extract<ReturnType<typeof getDatabase>, { ok: true }>['val'];
  const claimOne = async (db: Db, pinnedSource: string | null) => {
    const result = await sql<ClaimedMessage>`
      UPDATE ${live()}
      SET status = 'processing', locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
      WHERE id = (
        SELECT c.id FROM ${live()} c
        WHERE ${due()}
          ${sourceRestriction()}
          ${pinnedSource === null ? sql`` : sql`AND c.source = ${pinnedSource}`}
          AND (c.ordering_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM ${live()} b
            WHERE b.ordering_key = c.ordering_key
              AND b.status IN ('pending', 'processing')
              AND (b.created_at, b.id) < (c.created_at, c.id)
          ))
        ORDER BY c.created_at, c.id
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED
      )
      RETURNING id, tenant_id, source, type, payload, attempts
    `.execute(db);
    return result.rows[0] ?? null;
  };

  const consumer: QueueConsumer = {
    async claim() {
      const dbResult = getDatabase();
      if (!dbResult.ok) return null;

      if (config.fairAcrossSources) {
        // Uniform pick among sources with due work. Due, not deliverable:
        // the ordering-key gate is skipped here on purpose — it would make
        // the pick as expensive as the claim. The cost of the approximation
        // is a pick that lands on a source whose head is key-blocked; the
        // oldest-first fallback below covers exactly that.
        const picked = await sql<{ source: string }>`
          SELECT source FROM (
            SELECT DISTINCT c.source FROM ${live()} c
            WHERE ${due()}
              ${sourceRestriction()}
          ) candidates
          ORDER BY random()
          LIMIT 1
        `.execute(dbResult.val);
        const source = picked.rows[0]?.source;
        // No due rows at all — deliverable is a subset of due, so done.
        if (source === undefined) return null;
        const claimed = await claimOne(dbResult.val, source);
        if (claimed) return claimed;
      }

      return claimOne(dbResult.val, null);
    },

    async complete(message: ClaimedMessage, outcome: CompletionOutcome = 'processed') {
      const dbResult = getDatabase();
      if (!dbResult.ok) return;
      // 'skipped' is terminal exactly like 'processed' — the claim query
      // only ever looks at pending/processing — it differs only in what the
      // row tells an operator afterwards.
      if (config.clearPayloadOnComplete) {
        await sql`
          UPDATE ${live()}
          SET status = ${outcome}, locked_at = NULL, payload = '{}'::jsonb, updated_at = NOW()
          WHERE id = ${message.id}
        `.execute(dbResult.val);
      } else {
        await sql`
          UPDATE ${live()}
          SET status = ${outcome}, locked_at = NULL, updated_at = NOW()
          WHERE id = ${message.id}
        `.execute(dbResult.val);
      }
    },

    async fail(message: ClaimedMessage, error: string): Promise<Disposition> {
      const disposition = failureDisposition(message.attempts, policy);
      const dbResult = getDatabase();
      if (!dbResult.ok) return disposition;

      if (disposition.status === 'dead') {
        // MOVE to the dead-letter table atomically; the live table keeps no
        // trace, so its claim path stays lean and its ordering keys unblock.
        await sql`
          WITH moved AS (
            DELETE FROM ${live()} WHERE id = ${message.id}
            RETURNING id, tenant_id, source, type, payload, ordering_key, attempts, created_at
          )
          INSERT INTO ${dead()}
            (id, tenant_id, source, type, payload, ordering_key, attempts, last_error, created_at)
          SELECT id, tenant_id, source, type, payload, ordering_key, attempts, ${error}, created_at
          FROM moved
        `.execute(dbResult.val);
      } else {
        await sql`
          UPDATE ${live()}
          SET status = 'pending', locked_at = NULL, last_error = ${error},
              run_after = NOW() + INTERVAL '${sql.raw(String(disposition.delaySeconds))} seconds',
              updated_at = NOW()
          WHERE id = ${message.id}
        `.execute(dbResult.val);
      }
      return disposition;
    },
  };

  const deadLetters: DeadLetterStore = {
    async list(options = {}) {
      const dbResult = getDatabase();
      if (!dbResult.ok) return err('QUEUE_ERROR' as const, { message: 'database unavailable' });
      try {
        const result = await sql<DeadLetterRow>`
          SELECT id, tenant_id, source, type, payload, ordering_key, attempts, last_error, dead_at
          FROM ${dead()}
          ORDER BY dead_at DESC
          LIMIT ${options.limit ?? 100}
        `.execute(dbResult.val);
        return ok(
          result.rows.map((row) => ({
            id: row.id,
            tenant_id: row.tenant_id,
            source: row.source,
            type: row.type,
            payload: row.payload,
            orderingKey: row.ordering_key,
            attempts: row.attempts,
            lastError: row.last_error,
            deadAt: row.dead_at,
          }))
        );
      } catch (error) {
        return err('QUEUE_ERROR' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async requeue(ids) {
      if (ids.length === 0) return ok(0);
      const dbResult = getDatabase();
      if (!dbResult.ok) return err('QUEUE_ERROR' as const, { message: 'database unavailable' });
      try {
        // Fresh attempt budget, original enqueue order restored via the
        // preserved created_at, so requeued messages slot back into their
        // ordering keys where they left off.
        const result = await sql`
          WITH moved AS (
            DELETE FROM ${dead()} WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})
            RETURNING id, tenant_id, source, type, payload, ordering_key, created_at
          )
          INSERT INTO ${live()}
            (id, tenant_id, source, type, payload, ordering_key, status, attempts, run_after, created_at)
          SELECT id, tenant_id, source, type, payload, ordering_key, 'pending', 0, NOW(), created_at
          FROM moved
        `.execute(dbResult.val);
        return ok(Number(result.numAffectedRows ?? 0));
      } catch (error) {
        return err('QUEUE_ERROR' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async purge(ids) {
      if (ids.length === 0) return ok(0);
      const dbResult = getDatabase();
      if (!dbResult.ok) return err('QUEUE_ERROR' as const, { message: 'database unavailable' });
      try {
        const result = await sql`
          DELETE FROM ${dead()} WHERE id IN (${sql.join(ids.map((id) => sql`${id}`))})
        `.execute(dbResult.val);
        return ok(Number(result.numAffectedRows ?? 0));
      } catch (error) {
        return err('QUEUE_ERROR' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  const purger: QueuePurger = {
    async discardPending(tenantId, type, match) {
      const dbResult = getDatabase();
      if (!dbResult.ok) return err('QUEUE_ERROR' as const, { message: 'database unavailable' });
      if (match.length === 0) {
        // Refused rather than treated as "match everything": a predicate that
        // silently widened to the whole queue would be a catastrophe wearing
        // the clothes of a no-op.
        return err('QUEUE_ERROR' as const, { message: 'discardPending needs a predicate' });
      }

      // `#>>` walks a path and compares as text, so one form covers both a
      // top-level key and a nested one. Values are bound, never interpolated.
      const predicates = match.map(
        (entry) => sql`payload #>> ${sql.val(entry.path)} = ${entry.value}`
      );

      try {
        const result = await sql`
          DELETE FROM ${live()}
           WHERE tenant_id = ${tenantId}
             AND type = ${type}
             -- Pending only: a claimed message is being worked right now.
             AND status = 'pending'
             AND ${sql.join(predicates, sql` AND `)}
        `.execute(dbResult.val);
        return ok(Number(result.numAffectedRows ?? 0));
      } catch (error) {
        return err('QUEUE_ERROR' as const, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  return { producer, consumer, deadLetters, purger };
}

/**
 * The two queues Renkei runs today, table pairs from migrations 013/030.
 * Constructed here — and only here — so worker and web can never disagree
 * about a queue's configuration.
 */
export function webhookEventsQueue(options?: { sources?: readonly string[] }): Queue {
  return createPostgresQueue({
    table: 'events',
    deadLetterTable: 'events_dead_letters',
    // Interactive traffic from several connectors shares this queue; fair
    // claiming keeps one connector's storm from starving the others'
    // replies. `sources` additionally fixates a consumer instance.
    fairAcrossSources: true,
    sources: options?.sources,
  });
}

export function embeddingJobsQueue(): Queue {
  return createPostgresQueue({
    table: 'embedding_jobs',
    deadLetterTable: 'embedding_jobs_dead_letters',
    clearPayloadOnComplete: true,
    // Producers tag the source with a provider lane (`knowledge:jira`), so
    // one connector re-indexing a large space cannot put every other
    // connector's work behind it. Without this the queue is strictly
    // oldest-first, and a 1,000-page space is 1,000 places in the line.
    fairAcrossSources: true,
  });
}

export function agentJobsQueue(): Queue {
  return createPostgresQueue({
    table: 'agent_jobs',
    deadLetterTable: 'agent_jobs_dead_letters',
    // A legitimate agent run — an LLM loop with tool calls — can hold its
    // claim far past the default 10 minutes. The engine checkpoints every
    // attempt in agent_runs/agent_run_steps, so a reclaim after a real
    // crash RESUMES rather than re-executes; the longer lease just keeps
    // reclaims from racing runs that are merely slow.
    staleClaimMinutes: 30,
    // Queue-level retries mean "the engine died", not "a step failed" —
    // step retries are the engine's own, counted in agent_run_steps against
    // the user's attempt budget. Three redeliveries is plenty for crashes.
    policy: { maxAttempts: 3, baseDelaySeconds: 60, maxDelaySeconds: 3600 },
    // Producers tag the source with the agent (`agents:{agentId}`), making
    // each agent its own fairness lane: ordering keys already keep ONE
    // agent's runs serial, but without lane fairness a 50-run backlog on one
    // agent put every other agent's next run 50 places down the line.
    fairAcrossSources: true,
  });
}
