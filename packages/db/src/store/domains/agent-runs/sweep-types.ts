/**
 * What the agents worker's run sweeps read and write
 * (apps/worker-agents: approval-sweep.ts, maintenance.ts): waiting runs and
 * their cards, retention, and the stuck-run janitor. Callers pass the
 * cutoffs; the store compares against them.
 */

/** A run to wake, by id and agent. */
export interface AgentRunRefRecord {
  id: string;
  agentId: string;
}

/** A queued or running run old enough to be checked for a lost job. */
export interface AgentRunStaleRecord {
  id: string;
  agentId: string;
  ownerSubject: string;
  startedAt: Date | null;
}

export interface AgentRunSweepStore {
  /** Waiting runs whose wait ran out at or before `now`, soonest first (ties by id). */
  listDueWaiting(now: Date, limit: number): Promise<AgentRunRefRecord[]>;
  /**
   * Claim the run's still-suggested card as expired (decided and archived
   * now, `{ reason }` as its result). False when no card was still
   * suggested — someone decided first.
   */
  expireWaitingCard(runId: string, reason: string): Promise<boolean>;
  /**
   * Waiting runs with a card decided (approved, declined, expired or
   * answered) at or before `decidedBefore` — one entry per such card, by
   * run id then card id.
   */
  listWaitingWithDecidedCard(decidedBefore: Date, limit: number): Promise<AgentRunRefRecord[]>;
  /** Waiting runs with no card at all, last updated at or before `updatedBefore`, by id. */
  listWaitingWithoutCard(updatedBefore: Date, limit: number): Promise<AgentRunRefRecord[]>;
  /**
   * Expire and archive every still-suggested card whose run is no longer
   * waiting, running or queued (`{ reason: 'run-ended' }`); returns how many.
   */
  expireCardsOfEndedRuns(): Promise<number>;
  /**
   * Retention: delete up to `limit` settled runs (succeeded, failed,
   * canceled, stopped) created before `before`, oldest first (ties by id);
   * returns how many went. Their steps cascade.
   */
  pruneFinishedBefore(before: Date, limit: number): Promise<number>;
  /** Queued or running runs created before `createdBefore`, oldest first (ties by id). */
  listStaleInProgress(createdBefore: Date, limit: number): Promise<AgentRunStaleRecord[]>;
  /**
   * Close a still queued or running run as failed with this error, finished
   * now. False when it had already left those states.
   */
  failAbandoned(runId: string, failure: { errorKind: string; error: string }): Promise<boolean>;
}
