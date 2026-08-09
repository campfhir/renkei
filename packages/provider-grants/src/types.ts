import type { Result } from '@campfhir/safe-functions/types';

/**
 * A per-user OAuth credential for one provider, decrypted.
 *
 * `metadata` is provider-shaped (Atlassian keeps `{cloudId, siteUrl}` there;
 * Microsoft will keep whatever Graph needs) — the generic lifecycle never
 * interprets it, only round-trips it.
 */
export interface ProviderGrant {
  provider: string;
  accountId: string;
  clientId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  /** What the (possibly user-narrowed) authorize step asked the provider for. */
  requestedScopes: string[];
  /**
   * What the minted token actually carries, decoded from its claims. Null for
   * opaque tokens (WebEx) — unknown, never assumed equal to the request.
   */
  grantedScopes: string[] | null;
  metadata: Record<string, unknown>;
  /**
   * OIDC subject of the signed-in user who connected this grant. Null only for
   * rows created before grants were owned — those are unusable and must not be
   * served to a caller, since we cannot tell whose account they are.
   */
  subject: string | null;
}

/** Writes always record an owner; only reads can surface a legacy unowned row. */
export type NewProviderGrant = Omit<ProviderGrant, 'subject' | 'provider'> & { subject: string };

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export type RefreshError = 'REFRESH_FAILED' | 'GRANT_REVOKED';

/**
 * What a provider must implement for the generic grant lifecycle to manage
 * its tokens. This is the seam Decision #9 (RENKEI.md) calls for: adding
 * Microsoft means a new adapter and new grant rows — the store, encryption,
 * cross-process locking, and revocation handling above it do not change.
 *
 * `GRANT_REVOKED` must be returned only when the provider says the refresh
 * token itself is dead (e.g. OAuth `invalid_grant`) — the orchestrator deletes
 * the grant on that signal, and deleting on a transient failure would destroy
 * a working authorization.
 */
export interface ProviderAdapter {
  /** Key stored in provider_grants.provider, e.g. 'atlassian'. */
  readonly provider: string;
  refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>>;
}

/** Minimal logger the lifecycle reports through; silent when omitted. */
export interface GrantLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: GrantLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
