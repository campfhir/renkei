/**
 * The producer side of the Postgres-backed queues (@renkei/queue): adding
 * a message, and discarding pending ones a rebuild made stale. Claiming,
 * leasing, retries and dead letters stay with the queue's consumers in the
 * workers (FOR UPDATE SKIP LOCKED has no memory twin worth writing).
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
}
