/**
 * @renkei/queue — the queue contract, independent of what carries it.
 *
 * Renkei's queues run on Postgres today (Decision #17: no new
 * infrastructure), but nothing in THIS file knows that. The contract is
 * deliberately shaped like the primitives every serious broker shares, so
 * a RabbitMQ or Kafka adapter could implement it without changing a single
 * producer or consumer:
 *
 *   - pull-based consumption with a delivery lease: a claimed message that
 *     is neither completed nor failed within the lease returns to the
 *     queue (Postgres: stale `locked_at` reclaim; RabbitMQ: unacked
 *     redelivery; SQS: visibility timeout).
 *   - explicit ack/nack: `complete` acknowledges, `fail` routes through
 *     the retry policy — redelivery with backoff until the attempt budget
 *     is spent, then the dead-letter store (RabbitMQ: DLX; Kafka: a DLQ
 *     topic).
 *   - delivery counting: `attempts` is the count INCLUDING the current
 *     delivery, incremented at claim time, so a consumer crash still
 *     consumes an attempt and a poison message cannot loop forever.
 *   - optional per-message ordering keys: messages sharing a key are
 *     delivered strictly in enqueue order, one at a time — the analog of a
 *     Kafka partition key or a RabbitMQ consistent-hash routing key. This
 *     is what lets consumers scale horizontally: any number of worker
 *     instances may compete for messages (Postgres: FOR UPDATE SKIP LOCKED
 *     row locks), and ordering still holds exactly where it was asked for.
 *     Messages with no key have no ordering guarantee beyond best-effort
 *     age priority.
 *
 * The dead-letter store is part of the contract, not an afterthought:
 * every queue has one, dead messages MOVE there (keeping the live queue's
 * claim path small), and `requeue` is the supported way to reprocess them
 * after the underlying fault is fixed.
 */

import type { Json } from '@renkei/db';
import type { Result } from '@campfhir/safe-functions/types';

/** What a producer hands the queue. */
export interface QueueMessageInput {
  tenantId: string;
  /** The producing connector or subsystem ('webex', 'knowledge', ...). */
  source: string;
  /** The message kind within the source's namespace. */
  type: string;
  payload: Record<string, unknown>;
  /**
   * Messages sharing an ordering key are delivered one at a time, oldest
   * first, across ALL consumer instances of the queue. Omit (or null) for
   * messages with no ordering requirement.
   */
  orderingKey?: string | null;
}

/**
 * A delivered message. Field names match the historical `events` row shape
 * so consumers (worker handlers) are adapter-agnostic without translation.
 */
export interface ClaimedMessage {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: Json;
  /** Attempt number of THIS delivery (already incremented by the claim). */
  attempts: number;
}

/** What happened to a failed message. */
export type Disposition = { status: 'retry'; delaySeconds: number } | { status: 'dead' };

export interface QueueProducer {
  enqueue(message: QueueMessageInput): Promise<Result<void, 'QUEUE_ERROR'>>;
}

/**
 * How a completed message resolved. 'skipped' is still an ack — the message
 * is done and never redelivered — but records that the handler decided there
 * was nothing to do (no grant on file, a stale notification, a feature off)
 * rather than doing the work. Without the distinction, "processed" on the
 * admin's event monitor claims work happened when it silently did not — the
 * silent-success class this codebase keeps relearning.
 */
export type CompletionOutcome = 'processed' | 'skipped';

export interface QueueConsumer {
  /** The oldest deliverable message, or null when there is none. */
  claim(): Promise<ClaimedMessage | null>;
  /** Ack: the message is done and will never be delivered again. */
  complete(message: ClaimedMessage, outcome?: CompletionOutcome): Promise<void>;
  /** Nack: retry per policy, or move to the dead-letter store. */
  fail(message: ClaimedMessage, error: string): Promise<Disposition>;
}

export interface DeadLetter {
  id: string;
  tenant_id: string;
  source: string;
  type: string;
  payload: Json;
  orderingKey: string | null;
  /** Deliveries consumed before dead-lettering. */
  attempts: number;
  lastError: string | null;
  deadAt: Date;
}

export interface DeadLetterStore {
  list(options?: { limit?: number }): Promise<Result<DeadLetter[], 'QUEUE_ERROR'>>;
  /**
   * Move dead messages back into the live queue with a fresh attempt
   * budget — the reprocessing path once the underlying fault is fixed.
   * Returns how many actually moved (unknown ids are skipped, not errors).
   */
  requeue(ids: readonly string[]): Promise<Result<number, 'QUEUE_ERROR'>>;
  /** Drop dead messages permanently. Returns how many were dropped. */
  purge(ids: readonly string[]): Promise<Result<number, 'QUEUE_ERROR'>>;
}

/**
 * Discarding queued work that a later decision has superseded.
 *
 * Needed because a rebuild is two halves. Deleting what was indexed is one;
 * the other is deleting the not-yet-processed messages that would rebuild it,
 * because a queue does not know its payload went stale. Renkei learned this
 * the hard way: re-indexing a Jira project purged its chunks, and the backlog
 * then rewrote every one of them from content built by the previous release.
 * The purge looked like it had done nothing.
 *
 * Only PENDING messages are eligible. A claimed message is being worked by
 * someone right now and pulling it out from under them is a different and much
 * worse problem than one stale row.
 */
export interface QueuePurger {
  /**
   * Delete pending messages whose payload matches every entry in `match`,
   * compared as JSON text at the given path. Returns how many went.
   */
  discardPending(
    tenantId: string,
    type: string,
    match: readonly { path: readonly string[]; value: string }[]
  ): Promise<Result<number, 'QUEUE_ERROR'>>;
}

/** One named queue: its producer, consumer, and dead-letter store. */
export interface Queue {
  producer: QueueProducer;
  consumer: QueueConsumer;
  deadLetters: DeadLetterStore;
  purger: QueuePurger;
}
