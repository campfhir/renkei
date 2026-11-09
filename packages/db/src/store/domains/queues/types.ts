import type { Json } from '../../../db.types';

/**
 * The tables under @renkei/queue: producing (enqueue, discarding pending
 * messages a rebuild made stale) and consuming (claim with a lease, ack,
 * nack into a retry or the dead-letter table, release, and the dead-letter
 * store's list/requeue/purge).
 *
 * Postgres claims with FOR UPDATE SKIP LOCKED, so any number of consumer
 * processes compete safely. The memory store is one process: its claim is
 * a plain filter, sort and update over the same rows, which gives the same
 * answer for the same rows because nothing else can hold a lock there.
 */

/** The queues' live tables (migrations 013/030/036/077). */
export type QueueTable = 'events' | 'embedding_jobs' | 'agent_jobs' | 'batch_job_messages';

export interface QueueEnqueueInput {
  source: string;
  type: string;
  /** Stored as jsonb. */
  payload: unknown;
  orderingKey: string | null;
  /**
   * Skip the insert when a PENDING message with the same source, type and
   * ordering key already waits (a no-op without an ordering key).
   */
  coalesce?: boolean;
}

/** One pending message as stored (for reads after a write). */
export interface QueuePendingRecord {
  source: string;
  type: string;
  payload: unknown;
  orderingKey: string | null;
}

export interface QueueStore {
  /** Add one pending message, due now. */
  enqueue(table: QueueTable, message: QueueEnqueueInput): Promise<void>;
  /**
   * Delete PENDING messages of `type` whose payload matches every entry —
   * the value at `path`, as text (`payload #>> path`), equal to `value`.
   * Returns how many went. An empty `match` is refused (it would mean
   * every message).
   */
  discardPending(
    table: QueueTable,
    type: string,
    match: readonly { path: readonly string[]; value: string }[]
  ): Promise<number>;
  /** The pending messages, oldest first (ties by id). */
  listPending(table: QueueTable): Promise<QueuePendingRecord[]>;
  /**
   * Force-halt's queue half: mark the run's live agent_jobs rows (pending
   * or processing, `payload->>'runId'` = runId) skipped, unlocked, and
   * drop its agent_jobs dead letters, in one step. Returns how many of
   * each.
   */
  discardAgentRunJobs(runId: string): Promise<{ skipped: number; deadLetters: number }>;

  /**
   * Claim the oldest deliverable message and lease it: status processing,
   * locked now, attempts + 1. Deliverable means due (pending with run_after
   * passed, or processing with a lease older than `staleClaimMinutes`) and,
   * for a keyed message, no older pending or processing message sharing
   * its ordering key. Oldest is created_at, then id. Null when nothing is
   * deliverable.
   *
   * With `maxAttempts`, an expired lease on a message already delivered
   * that many times is not handed out again: the claim first moves every
   * such row (of the claim's sources) to the dead letters, with
   * LEASE_EXPIRED_ERROR as its last error. A consumer that dies or hangs
   * never calls fail, so without this its message would be reclaimed on
   * every lease forever and hold its ordering key for good.
   */
  claim(table: QueueTable, options: QueueClaimOptions): Promise<QueueClaimedRecord | null>;
  /**
   * Ack: the message's status becomes `outcome`, unlocked; `clearPayload`
   * blanks it to {}. With `attempts`, only while it is still processing at
   * that count. True when the row was written.
   */
  complete(
    table: QueueTable,
    id: string,
    outcome: QueueCompletionOutcome,
    options?: { clearPayload?: boolean } & QueueLeaseGuard
  ): Promise<boolean>;
  /**
   * Hand a claimed message back: pending, unlocked, due now, this delivery
   * uncounted — only while it is still processing at `attempts` (a message
   * another consumer has since reclaimed is left alone).
   */
  release(table: QueueTable, id: string, attempts: number): Promise<void>;
  /**
   * Renew a held lease: locked now — only while it is still processing at
   * `attempts`. False when the lease is no longer this delivery's (it
   * expired and another consumer reclaimed it, or the row was settled).
   */
  extendLease(table: QueueTable, id: string, attempts: number): Promise<boolean>;
  /**
   * Nack into a retry: pending, unlocked, `error` recorded, due in
   * `delaySeconds`. With `attempts`, only while it is still processing at
   * that count. True when the row was written.
   */
  retry(
    table: QueueTable,
    id: string,
    error: string,
    delaySeconds: number,
    options?: QueueLeaseGuard
  ): Promise<boolean>;
  /**
   * Nack into the dead-letter table: the live row moves there in one step
   * (created_at kept, `error` as its last error, dead now). With
   * `attempts`, only while it is still processing at that count. True when
   * the row moved.
   */
  deadLetter(
    table: QueueTable,
    id: string,
    error: string,
    options?: QueueLeaseGuard
  ): Promise<boolean>;
  /** One live message by id, or null. */
  find(table: QueueTable, id: string): Promise<QueueMessageRecord | null>;
  /**
   * Delete up to `limit` settled messages (`processed`, `skipped`) created
   * before `before`, oldest first (ties by id); returns how many went. The
   * live rows (pending, processing) are never touched, whatever their age.
   */
  pruneSettled(table: QueueTable, before: Date, limit: number): Promise<number>;
  /** The queue's dead letters, most recently dead first (ties by id, descending). */
  listDeadLetters(table: QueueTable, limit: number): Promise<QueueDeadLetterRecord[]>;
  /**
   * Move dead letters back to the live table: pending, no attempts, due
   * now, created_at kept so they slot back into their ordering keys.
   * Unknown ids are skipped. Returns how many moved.
   */
  requeueDeadLetters(table: QueueTable, ids: readonly string[]): Promise<number>;
  /** Drop dead letters for good; returns how many went. */
  purgeDeadLetters(table: QueueTable, ids: readonly string[]): Promise<number>;
  /** Whether a pending or processing agent_jobs row carries this run (`payload->>'runId'`). */
  hasLiveAgentRunJob(runId: string): Promise<boolean>;
  /**
   * One agent's live agent_jobs rows (pending or processing, source
   * `agents:{agentId}`): its runs and their action batches, oldest first
   * (ties by id), at most `limit`. What is holding an agent's queue, for the
   * runs page — content-free (ids, states, counts, the last error).
   */
  listAgentJobs(agentId: string, limit: number): Promise<AgentJobRecord[]>;
  /** The same agent's dead letters, most recently dead first (ties by id, descending). */
  listAgentDeadLetters(agentId: string, limit: number): Promise<AgentDeadLetterRecord[]>;
}

/** Every live queue table's dead-letter twin (`<table>_dead_letters`). */
export type QueueDeadLetterTable =
  | 'events_dead_letters'
  | 'embedding_jobs_dead_letters'
  | 'agent_jobs_dead_letters'
  | 'batch_job_messages_dead_letters';

/**
 * A settle made by the consumer holding a delivery: it applies only while
 * the row is still processing at the `attempts` its claim returned. A
 * consumer whose lease expired and was reclaimed by another then cannot
 * ack, retry or dead-letter the newer delivery out from under it — which
 * would unlock the row, and its ordering key, while that one still runs.
 */
export interface QueueLeaseGuard {
  attempts?: number;
}

/** The last error of a message dead-lettered because its final lease expired. */
export const LEASE_EXPIRED_ERROR =
  'The consumer holding this message stopped responding: its lease expired on its last allowed delivery.';

export interface QueueClaimOptions {
  /** A processing row locked longer ago than this is a dead consumer's: claimable again. */
  staleClaimMinutes: number;
  /**
   * Deliveries a message may have. An expired lease at this count is moved
   * to the dead letters instead of being claimed again (see claim).
   * Absent: no limit.
   */
  maxAttempts?: number;
  /** Only messages from these sources (empty or absent: every source). */
  sources?: readonly string[];
  /**
   * Pick a source uniformly at random among those with due work, then take
   * its oldest deliverable message; fall back to the plain oldest-first
   * claim when that source has nothing deliverable.
   */
  fairAcrossSources?: boolean;
}

/** A message a claim handed out: its attempts already count this delivery. */
export interface QueueClaimedRecord {
  id: string;
  source: string;
  type: string;
  payload: Json;
  attempts: number;
}

/** One live message, every column (for reads after a consumer's write). */
export interface QueueMessageRecord {
  id: string;
  source: string;
  type: string;
  payload: Json;
  orderingKey: string | null;
  status: string;
  attempts: number;
  runAfter: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

/** One dead-lettered message. */
export interface QueueDeadLetterRecord {
  id: string;
  source: string;
  type: string;
  payload: Json;
  orderingKey: string | null;
  attempts: number;
  lastError: string | null;
  deadAt: Date;
}

/** One live job of an agent's (listAgentJobs). */
export interface AgentJobRecord {
  id: string;
  type: string;
  /** The run it carries, for a run job (`payload.runId`). */
  runId: string | null;
  /** The action batch it carries, for an actions job (`payload.batchId`). */
  batchId: string | null;
  status: string;
  attempts: number;
  lockedAt: Date | null;
  runAfter: Date;
  lastError: string | null;
  createdAt: Date;
}

/** One dead letter of an agent's (listAgentDeadLetters). */
export interface AgentDeadLetterRecord {
  id: string;
  type: string;
  runId: string | null;
  batchId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  deadAt: Date;
}

/** How a completed message resolved; both are terminal. */
export type QueueCompletionOutcome = 'processed' | 'skipped';
