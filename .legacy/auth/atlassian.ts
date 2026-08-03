/**
 * Atlassian OAuth 2.0 (3LO) protocol calls.
 *
 * This is the Renkei -> Atlassian leg only, and it is a confidential-client
 * authorization-code exchange: Atlassian 3LO does not publicly support PKCE
 * (ECO-283). PKCE belongs on the MCP client -> Renkei leg, which the stdio
 * entrypoint does not have. See README § Authentication flow.
 *
 * Refresh tokens rotate on every use. `refreshAccessToken` returns the new
 * one and callers MUST persist it before the old token's 10-minute reuse
 * window closes, or the grant is unrecoverable and the user has to re-consent.
 */

import type { AtlassianConfig } from '@/lib/config';
import { asString } from '@/lib/util/coerce';

export const ATLASSIAN_AUTH_BASE = 'https://auth.atlassian.com';
export const ATLASSIAN_API_BASE = 'https://api.atlassian.com';

export type FetchLike = typeof fetch;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, ISO 8601. Derived from `expires_in` at exchange time. */
  expiresAt: string;
  scopes: string[];
}

export interface AccessibleResource {
  id: string;
  url: string;
  name: string;
  scopes: string[];
}

export interface AtlassianUser {
  accountId: string;
  displayName: string;
  emailAddress: string | undefined;
}

export class AtlassianAuthError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AtlassianAuthError';
    this.status = status;
  }
}

export interface AuthorizeUrlOptions {
  /**
   * Also force re-authentication, not just re-consent. Without this, a browser
   * already signed in to Atlassian authorizes as that account with no way to
   * pick a different one — which matters when the signed-in account is not the
   * one whose Jira permissions the grant should carry.
   */
  forceLogin?: boolean;
}

export function buildAuthorizeUrl(
  config: AtlassianConfig,
  state: string,
  options: AuthorizeUrlOptions = {},
): string {
  const url = new URL('/authorize', ATLASSIAN_AUTH_BASE);

  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  // Force the consent screen so a scope change is actually re-approved rather
  // than silently reusing an older, narrower grant. `login` is the OIDC value
  // for re-authentication; Atlassian documents only `consent`, so treat the
  // account switch as best-effort and fall back to signing out of Atlassian.
  url.searchParams.set('prompt', options.forceLogin === true ? 'login consent' : 'consent');

  return url.toString();
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

async function postTokenRequest(
  body: Record<string, string>,
  fetchImpl: FetchLike,
  previousRefreshToken?: string,
): Promise<TokenSet> {
  const response = await fetchImpl(`${ATLASSIAN_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Never echo the payload: it can contain the submitted client_secret.
    throw new AtlassianAuthError(
      `Atlassian token endpoint returned ${response.status} for grant_type=${body.grant_type ?? '?'}`,
      response.status,
    );
  }

  const raw = payload as RawTokenResponse;
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined;
  const refreshToken =
    typeof raw.refresh_token === 'string' ? raw.refresh_token : previousRefreshToken;
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600;

  if (!accessToken) {
    throw new AtlassianAuthError('Atlassian token response contained no access_token', 502);
  }

  return {
    accessToken,
    refreshToken: refreshToken ?? '',
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scopes: typeof raw.scope === 'string' ? raw.scope.split(' ').filter(Boolean) : [],
  };
}

export function exchangeAuthorizationCode(
  config: AtlassianConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  return postTokenRequest(
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    },
    fetchImpl,
  );
}

export function refreshAccessToken(
  config: AtlassianConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  return postTokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    fetchImpl,
    refreshToken,
  );
}

export async function fetchAccessibleResources(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<AccessibleResource[]> {
  const response = await fetchImpl(`${ATLASSIAN_API_BASE}/oauth/token/accessible-resources`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });

  if (!response.ok) {
    throw new AtlassianAuthError(
      `accessible-resources returned ${response.status}`,
      response.status,
    );
  }

  const payload: unknown = await response.json();

  if (!Array.isArray(payload)) {
    throw new AtlassianAuthError('accessible-resources returned a non-array payload', 502);
  }

  return payload.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      id: asString(record.id),
      url: asString(record.url),
      name: asString(record.name),
      scopes: Array.isArray(record.scopes) ? record.scopes.map(String) : [],
    };
  });
}

/**
 * Site pinning. A grant can cover more than one Atlassian site; the deployment
 * serves exactly one. Refusing to proceed when the configured cloud ID is not
 * in the grant is what stops a token from reaching a tenant it was never
 * intended for.
 */
export function assertCloudIdInGrant(
  resources: readonly AccessibleResource[],
  cloudId: string,
): AccessibleResource {
  const match = resources.find((resource) => resource.id === cloudId);

  if (!match) {
    const available = resources.map((resource) => `${resource.id} (${resource.url})`).join(', ');
    throw new AtlassianAuthError(
      `ATLASSIAN_CLOUD_ID ${cloudId} is not in this grant. Authorized sites: ${available || 'none'}`,
      403,
    );
  }

  return match;
}
