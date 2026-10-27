/**
 * What the organization's people are connected to, as the admin console
 * reads it: connector grants (no tokens), who holds an encryption key, and
 * the scopes content watches index. Per-person grant management (connect,
 * refresh) is not here — this is the operator's view and the operator's
 * revoke.
 */

/** One connector grant, credentials left out. */
export interface GrantSummary {
  provider: string;
  accountId: string;
  /** Null for a grant from before per-person ownership. */
  subject: string | null;
  displayName: string;
  expiresAt: Date;
  /** The grant's provider metadata (an Atlassian grant's cloud id and site URL). */
  metadata: unknown;
  createdAt: Date;
}

export interface ContentWatchSummary {
  provider: string;
  scopeType: string;
  scopeLabel: string | null;
  scopeKey: string;
  enabled: boolean;
  syncStatus: string;
}

export interface OrgAccessStore {
  /** Every grant, by provider then account id. */
  listGrants(): Promise<GrantSummary[]>;
  /** The grants of these providers, by provider then account id. */
  listGrantsOfProviders(providers: string[]): Promise<GrantSummary[]>;
  /** Grants whose account id is among these, by provider then account id. */
  grantsForAccounts(accountIds: string[]): Promise<GrantSummary[]>;
  /** A subject's first grant by provider then account id — a name for someone who never signed in. */
  firstGrantOf(subject: string): Promise<GrantSummary | null>;
  /**
   * Delete one grant and, when it names a subject, every MCP access and
   * refresh token of that subject, in one step. Null when there was no
   * such grant (nothing changes).
   */
  revokeGrant(provider: string, accountId: string): Promise<GrantSummary | null>;
  /** Who holds an encryption key, and in which mode, by subject. */
  listKeyHolders(): Promise<{ subject: string; mode: string }[]>;
  /** Every content watch's scope, by provider then id. */
  listContentWatches(): Promise<ContentWatchSummary[]>;
}
