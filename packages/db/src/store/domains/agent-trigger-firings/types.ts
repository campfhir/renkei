/**
 * The trigger-firing ledger (`agent_trigger_firings`): one row per
 * (trigger, source event), so the same event delivered twice — a queue
 * redelivery, a duplicate webhook registration — starts one run, across
 * every worker process (packages/agents event-fanout). Rows only need to
 * outlive the duplicate horizon; the worker's hourly sweep prunes them.
 */
export interface AgentTriggerFiringRecord {
  triggerId: string;
  dedupeKey: string;
  runId: string | null;
  createdAt: Date;
}

export interface AgentTriggerFiringStore {
  /**
   * The firing lock: insert (trigger, key) with no run yet. True for the
   * one caller that inserted it; false when it was already there.
   */
  claim(triggerId: string, dedupeKey: string): Promise<boolean>;
  /** Record the run a claimed firing started. */
  setRun(triggerId: string, dedupeKey: string, runId: string): Promise<void>;
  /** Give a claim back (the run was refused), so a redelivery may retry. */
  release(triggerId: string, dedupeKey: string): Promise<void>;
  /** One firing, or null. */
  find(triggerId: string, dedupeKey: string): Promise<AgentTriggerFiringRecord | null>;
  /**
   * Delete up to `limit` firings older than `days` days (by the database's
   * clock), oldest first (ties by trigger id, then key); returns how many went.
   */
  pruneOlderThan(days: number, limit: number): Promise<number>;
}
