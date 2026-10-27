/**
 * A person's grant on a provider without its tokens: who, what account,
 * which scopes, and the provider's metadata. The sealed tokens stay with
 * @renkei/provider-grants, which opens them under their owner's key.
 */
export interface ProviderGrantSummaryRecord {
  provider: string;
  accountId: string;
  subject: string | null;
  displayName: string;
  requestedScopes: string[];
  grantedScopes: string[] | null;
  metadata: unknown;
}

/** One grant with its tokens still sealed under the owner's key, as stored. */
export interface ProviderGrantSealedRecord extends ProviderGrantSummaryRecord {
  clientId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
}

/** What a (re)connect writes; the tokens arrive already sealed. */
export interface ProviderGrantSealedInput {
  accountId: string;
  clientId: string;
  displayName: string;
  subject: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  /**
   * On a reconnect, keep the stored refresh token rather than this one —
   * a repeat authorization that came back without a refresh token must
   * not overwrite one that still works.
   */
  keepStoredRefreshToken: boolean;
  expiresAt: Date;
  requestedScopes: string[];
  grantedScopes: string[] | null;
  metadata: Record<string, unknown>;
}

export interface ProviderGrantStore {
  /**
   * One person's grants, by provider then account id. `provider` keeps one
   * provider's; `providerPrefix` those whose provider starts with it
   * (`mcp:` — the remote MCP servers).
   */
  listForSubject(
    subject: string,
    options?: { provider?: string; providerPrefix?: string }
  ): Promise<ProviderGrantSummaryRecord[]>;
  /**
   * Every grant on one provider, whoever holds it — a remote MCP server's
   * registration went or changed, so no token outlives it. Returns how many.
   */
  deleteForProvider(provider: string): Promise<number>;
  /**
   * Lay `patch`'s keys over one grant's metadata (jsonb `||`, so a
   * concurrent writer's other keys survive) and touch `updated_at` —
   * unless `touch` is false (a sweep's bookkeeping, which must not make
   * the grant look recently used); returns how many rows changed (0 or 1).
   */
  mergeMetadata(
    provider: string,
    accountId: string,
    patch: Record<string, unknown>,
    options?: { touch?: boolean }
  ): Promise<number>;
  /** One grant by provider and account id, whoever holds it; null when there is none. */
  find(provider: string, accountId: string): Promise<ProviderGrantSummaryRecord | null>;
  /**
   * The most recently updated grant on any of these providers (ties by
   * provider, then account id), or only `subject`'s; null when there is
   * none. A connect borrows a sibling grant's site and identity from it.
   */
  latestOf(
    providers: string[],
    options?: { subject?: string }
  ): Promise<ProviderGrantSummaryRecord | null>;
  /**
   * Delete one person's grants on a provider together with every MCP access
   * and refresh token issued to them, in one step: a disconnect must not
   * leave a bearer token resolving to a grant that is gone. Returns how
   * many of each went.
   */
  disconnectWithMcpTokens(
    provider: string,
    subject: string
  ): Promise<{ grants: number; accessTokens: number; refreshTokens: number }>;
  /** One grant, tokens sealed as stored; null when there is none. */
  findSealed(provider: string, accountId: string): Promise<ProviderGrantSealedRecord | null>;
  /**
   * Insert a grant, or on (provider, account) replace its tokens, expiry,
   * scopes, metadata and owner (created_at, client id and display name
   * stay), touching `updated_at`.
   */
  upsertSealed(provider: string, grant: ProviderGrantSealedInput): Promise<void>;
  /**
   * A refresh's new sealed tokens and expiry; `grantedScopes` replaces the
   * stored ones only when given. Returns how many rows changed (0 or 1).
   */
  updateSealedTokens(
    provider: string,
    accountId: string,
    tokens: {
      encryptedAccessToken: string;
      encryptedRefreshToken: string;
      expiresAt: Date;
      grantedScopes: string[] | null;
    }
  ): Promise<number>;
  /** Delete one grant; returns how many went. */
  delete(provider: string, accountId: string): Promise<number>;

  /**
   * The cross-process refresh lock (provider_refresh_locks): take it at
   * `at`; false when someone already holds it.
   */
  acquireRefreshLock(provider: string, accountId: string, at: Date): Promise<boolean>;
  /** When the lock was taken, or null when nobody holds it. */
  findRefreshLock(provider: string, accountId: string): Promise<Date | null>;
  releaseRefreshLock(provider: string, accountId: string): Promise<void>;

  /**
   * A grant by provider account id alone, on whichever provider (the first
   * by provider name when several share the id); null when there is none.
   * For naming the person behind a connector-side row in a log line.
   */
  findByAccount(accountId: string): Promise<ProviderGrantSummaryRecord | null>;
  /**
   * The first grant on `provider` (by account id) whose `metadata ->> key`
   * is exactly `value`; null when there is none. A Zoom delivery that names
   * only its host's email finds the host's grant this way.
   */
  findByMetadataText(
    provider: string,
    key: string,
    value: string
  ): Promise<ProviderGrantSummaryRecord | null>;
  /**
   * The first grant on `provider` (by account id) held by someone whose
   * recorded identity has exactly this email; null when there is none.
   * The gates verify by email, grants are keyed by subject: identities is
   * the bridge.
   */
  findByHolderEmail(provider: string, email: string): Promise<ProviderGrantSummaryRecord | null>;
  /**
   * Every grant on one provider, whoever holds it, narrowed by metadata:
   * `equals` keys whose `metadata ->> key` is exactly the value, `missing`
   * keys absent (or JSON null). By account id — or, `newestFirst`, most
   * recently updated first (ties by account id) — at most `limit`.
   */
  listWithMetadata(
    provider: string,
    filter?: { equals?: Record<string, string>; missing?: string[] },
    options?: { newestFirst?: boolean; limit?: number }
  ): Promise<ProviderGrantSummaryRecord[]>;
  /**
   * Grants, on any provider, whose expiry is more than `days` days past
   * (by the database's clock) — abandoned: a live grant's expiry keeps
   * moving forward. By provider, then account id, at most `limit`.
   */
  listStaleExpired(days: number, limit: number): Promise<{ provider: string; accountId: string }[]>;
  /**
   * Delete one grant only if it is still more than `days` days past its
   * expiry — a refresh that landed since the listing wins. Returns how
   * many went (0 or 1).
   */
  deleteIfStale(provider: string, accountId: string, days: number): Promise<number>;
}
