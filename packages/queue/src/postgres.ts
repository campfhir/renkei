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
 * The SQL itself lives in @renkei/db's `queues` domain (one store call per
 * former query); this file is the contract's policy over it: retry versus
 * dead-letter, defaults, and the queue configurations. On the memory data
 * store the same calls run in-process.
 *
 * The claim query doubles as crash recovery: a `processing` row whose
 * `locked_at` is stale is a dead worker's orphan and is claimable again
 * (the delivery lease of the contract). Dead messages MOVE to the
 * dead-letter table in one CTE, so the live table's claim scan never pays
 * for history, and `requeue` moves them back with a fresh attempt budget.
 */

import { getDataStore, type QueueTable } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type {
  QueuePurger,
  ClaimedMessage,
  CompletionOutcome,
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
  /** Live table name: one of the data store's queue tables. */
  table: string;
  /** Dead-letter table name: always the live table's `<table>_dead_letters` twin. */
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

const QUEUE_TABLES: readonly QueueTable[] = [
  'events',
  'embedding_jobs',
  'agent_jobs',
  'batch_job_messages',
];

/** The data store's name for this queue's live table, when the pair is one it carries. */
function queueTable(config: PostgresQueueConfig): QueueTable | null {
  const table = QUEUE_TABLES.find((known) => known === config.table) ?? null;
  return table && config.deadLetterTable === `${table}_dead_letters` ? table : null;
}

function queueError(error: unknown) {
  return err('QUEUE_ERROR' as const, {
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * A queue on the data store's queue tables. Named for Postgres, which
 * carries it in production (the store's claim is FOR UPDATE SKIP LOCKED);
 * on the memory data store the same calls run in-process.
 */
export function createPostgresQueue(config: PostgresQueueConfig): Queue {
  // The store is resolved per call, never at construction: building a queue
  // stays side-effect free, so importing a module that wires one up touches
  // nothing.
  const policy = config.policy ?? DEFAULT_RETRY_POLICY;
  const unknownQueue = () =>
    err('QUEUE_ERROR' as const, { message: `unknown queue ${config.table}` });
  const requireTable = (): QueueTable => {
    const table = queueTable(config);
    if (!table) throw new Error(`unknown queue ${config.table}`);
    return table;
  };

  const producer: QueueProducer = {
    async enqueue(message: QueueMessageInput) {
      const table = queueTable(config);
      if (!table) return unknownQueue();
      try {
        await getDataStore().queues.enqueue(table, {
          source: message.source,
          type: message.type,
          payload: message.payload,
          orderingKey: message.orderingKey ?? null,
          coalesce: message.coalesce,
        });
        return ok();
      } catch (error) {
        return queueError(error);
      }
    },
  };

  const consumer: QueueConsumer = {
    async claim() {
      return getDataStore().queues.claim(requireTable(), {
        staleClaimMinutes: config.staleClaimMinutes ?? DEFAULT_STALE_CLAIM_MINUTES,
        sources: config.sources,
        fairAcrossSources: config.fairAcrossSources,
      });
    },

    async complete(message: ClaimedMessage, outcome: CompletionOutcome = 'processed') {
      await getDataStore().queues.complete(requireTable(), message.id, outcome, {
        clearPayload: config.clearPayloadOnComplete,
      });
    },

    async release(message: ClaimedMessage) {
      await getDataStore().queues.release(requireTable(), message.id, message.attempts);
    },

    async fail(message: ClaimedMessage, error: string): Promise<Disposition> {
      const disposition = failureDisposition(message.attempts, policy);
      const queues = getDataStore().queues;
      if (disposition.status === 'dead') {
        await queues.deadLetter(requireTable(), message.id, error);
      } else {
        await queues.retry(requireTable(), message.id, error, disposition.delaySeconds);
      }
      return disposition;
    },
  };

  const deadLetters: DeadLetterStore = {
    async list(options = {}) {
      const table = queueTable(config);
      if (!table) return unknownQueue();
      try {
        return ok(await getDataStore().queues.listDeadLetters(table, options.limit ?? 100));
      } catch (error) {
        return queueError(error);
      }
    },

    async requeue(ids) {
      if (ids.length === 0) return ok(0);
      const table = queueTable(config);
      if (!table) return unknownQueue();
      try {
        return ok(await getDataStore().queues.requeueDeadLetters(table, ids));
      } catch (error) {
        return queueError(error);
      }
    },

    async purge(ids) {
      if (ids.length === 0) return ok(0);
      const table = queueTable(config);
      if (!table) return unknownQueue();
      try {
        return ok(await getDataStore().queues.purgeDeadLetters(table, ids));
      } catch (error) {
        return queueError(error);
      }
    },
  };

  const purger: QueuePurger = {
    async discardPending(type, match) {
      if (match.length === 0) {
        // Refused rather than treated as "match everything": a predicate that
        // silently widened to the whole queue would be a catastrophe wearing
        // the clothes of a no-op.
        return err('QUEUE_ERROR' as const, { message: 'discardPending needs a predicate' });
      }
      const table = queueTable(config);
      if (!table) return unknownQueue();
      try {
        return ok(await getDataStore().queues.discardPending(table, type, match));
      } catch (error) {
        return queueError(error);
      }
    },
  };

  return { producer, consumer, deadLetters, purger };
}

/**
 * The queues Renkei runs today, table pairs from migrations 013/030/036/077.
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

export function batchJobsQueue(): Queue {
  return createPostgresQueue({
    table: 'batch_job_messages',
    deadLetterTable: 'batch_job_messages_dead_letters',
    // An OCR call (or whatever a future batch kind's item work is) is slow,
    // external, per-item I/O — closer to a Graph batch call than an LLM
    // loop, so the default 10-minute lease is plenty; no override needed.
    // Producers tag the source `batch:{batchJobId}` (see the migration's
    // own comment), so one huge batch cannot starve a smaller concurrent
    // one — the embedding_jobs provider-lane precedent applied per batch
    // instead of per connector.
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
