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
   * concurrent writer's other keys survive) and touch `updated_at`;
   * returns how many rows changed (0 or 1).
   */
  mergeMetadata(
    provider: string,
    accountId: string,
    patch: Record<string, unknown>
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
}
