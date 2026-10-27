/**
 * A person's content watches (content_watches): the scopes their grants
 * poll into the knowledge index, read for the progress view and the
 * rebuild route. The pollers own the cursor and the tallies; this resets
 * them for a rebuild and otherwise only reads.
 */
export interface ContentWatchRecord {
  id: string;
  provider: string;
  scopeType: string;
  scopeKey: string;
  scopeLabel: string | null;
  accountId: string;
  enabled: boolean;
  lastSyncedAt: Date | null;
  lastRunItems: number;
  totalItems: number;
  syncStatus: string;
  lastError: string | null;
}

export interface ContentWatchStore {
  /** One person's watches, by scope key (ties by provider, then id). */
  listForSubject(subject: string): Promise<ContentWatchRecord[]>;
  /** One of this person's watches, by provider and scope key (the oldest when several). */
  findForSubject(
    subject: string,
    provider: string,
    scopeKey: string
  ): Promise<ContentWatchRecord | null>;
  /**
   * Start a watch over: cursor and tallies cleared, never synced (so the
   * next sweep takes it at once), status 'syncing', error cleared.
   * Returns how many rows changed.
   */
  resetForRebuild(id: string): Promise<number>;
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
  /**
   * Enabled watches, whoever owns them, never synced or last synced before
   * `dueBefore`: never-synced first, then the stalest (ties by id), at
   * most `limit` — the poll sweep's candidates.
   */
  listDue(dueBefore: Date, limit: number): Promise<ContentWatchDueRecord[]>;
  /**
   * A poll failed: status `error` with the message as given, and synced
   * now all the same, so a broken watch is retried on the
   * normal cadence rather than every pass.
   */
  recordSyncFailure(id: string, message: string): Promise<void>;
}

/** A watch as the poller needs it: its scope, owner account and cursor. */
export interface ContentWatchDueRecord {
  id: string;
  provider: string;
  accountId: string;
  scopeType: string;
  scopeKey: string;
  scopeLabel: string | null;
  cursor: string | null;
  lastSyncedAt: Date | null;
}

/** A watch's owner: the subject, and the provider account whose grant the worker polls with. */
export interface ContentWatchOwner {
  subject: string;
  accountId: string;
}

/** Objects counted per scope (the scope a metadata key names; null when a row has none). */
export interface ContentWatchScopeCount {
  scope: string | null;
  objects: number;
}
