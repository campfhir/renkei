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
}
