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
  /** One grant by its provider account, whoever holds it, or null. */
  getByAccount(provider: string, accountId: string): Promise<ProviderGrantSummaryRecord | null>;
  /**
   * A person disconnects a provider: their grants on it go, and with them
   * every MCP access and refresh token issued to them — in one
   * transaction, so a grant never outlives its tokens or the reverse.
   * Returns how many grants went.
   */
  disconnectWithTokens(provider: string, subject: string): Promise<number>;
}
