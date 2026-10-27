/** A watch's owner: the subject, and the provider account whose grant the worker polls with. */
export interface ContentWatchOwner {
  subject: string;
  accountId: string;
}

/** One watch as its owner's list shows it (no cursor). */
export interface ContentWatchRecord {
  provider: string;
  scopeType: string;
  scopeKey: string;
  scopeLabel: string | null;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastRunItems: number;
  totalItems: number;
  syncStatus: string;
  lastError: string | null;
}

/** Objects counted per scope (the scope a metadata key names; null when a row has none). */
export interface ContentWatchScopeCount {
  scope: string | null;
  objects: number;
}

/**
 * Standing "keep this indexed" instructions (`content_watches`), and the
 * counts the watch list shows beside them.
 */
export interface ContentWatchStore {
  /**
   * Create or re-enable the owner's watch on a scope. An existing one is
   * re-enabled, its failure cleared, `idle`, rebound to `owner.accountId`
   * with the new label, cursor kept; `created` is whether it had been off.
   * A new one inherits the cursor of the most recently updated watch on
   * the same scope that has one (anyone's), so the index is not re-read;
   * `created` is true.
   */
  watch(
    owner: ContentWatchOwner,
    scope: { provider: string; scopeType: string; scopeKey: string; scopeLabel: string | null }
  ): Promise<{ created: boolean }>;
  /**
   * Rebind every watch on a scope, whoever owns it, to `owner`: enabled,
   * failure cleared, `idle`, never-synced (so it polls first), cursor kept.
   * Returns how many rows changed.
   */
  repair(
    owner: ContentWatchOwner,
    scope: { provider: string; scopeType: string; scopeKey: string }
  ): Promise<number>;
  /** Pause the subject's enabled watch on a scope; returns how many rows changed (0 or 1). */
  disable(
    subject: string,
    scope: { provider: string; scopeType: string; scopeKey: string }
  ): Promise<number>;
  /** The subject's watches on one provider, by scope key then scope type. */
  list(subject: string, provider: string): Promise<ContentWatchRecord[]>;
  /**
   * For one provider, by scope (`metadata ->> metadataKey`), ascending,
   * nulls last: distinct objects in the index (`ref_id` up to its `#`
   * chunk suffix), and pending embedding jobs (by the job payload's
   * `provider` and `metadata`).
   */
  objectCounts(
    provider: string,
    metadataKey: string
  ): Promise<{ indexed: ContentWatchScopeCount[]; queued: ContentWatchScopeCount[] }>;
}
