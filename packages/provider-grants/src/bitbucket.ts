/**
 * The Bitbucket Cloud implementation of ProviderAdapter.
 *
 * Bitbucket sits in the Atlassian family in the UI, but its OAuth is its
 * own system, not the 3LO platform: consumers live on bitbucket.org, the
 * token endpoint authenticates the app with HTTP Basic (like Zoom, unlike
 * Atlassian's JSON body), the body is form-encoded, and access tokens are
 * short-lived (~2h) with long-lived refresh tokens. Scopes are fixed on
 * the consumer — the authorize step cannot narrow them — so the token
 * response's `scopes` field is the granted set and any user narrowing
 * lives in requested_scopes, the same requested ∩ granted arrangement
 * Zoom uses.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const ATLASSIAN_BITBUCKET = 'atlassian-bitbucket';

const TOKEN_ENDPOINT = 'https://bitbucket.org/site/oauth2/access_token';

export class BitbucketAdapter implements ProviderAdapter {
  readonly provider = ATLASSIAN_BITBUCKET;

  constructor(private readonly clientSecret: string) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret) {
      return err('REFRESH_FAILED' as const, {
        message: 'Bitbucket client secret is not configured',
      });
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        // Bounded like every connector client: a stalled token endpoint must
        // not hang the caller's whole request path.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('REFRESH_FAILED' as const, {
        message: timedOut
          ? 'bitbucket.org token endpoint timed out after 15000ms'
          : 'Could not reach bitbucket.org',
      });
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      const record = asRecord(body);
      // Only an explicit invalid_grant means the refresh token is genuinely
      // dead — the one signal on which the lifecycle may delete the grant.
      // Everything else (client auth, network, 5xx) is ours to fix.
      if (record.error === 'invalid_grant') {
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const, {
        message: `Bitbucket token refresh failed (${response.status})`,
      });
    }

    const data: unknown = await response.json().catch(() => null);
    if (typeof data !== 'object' || data === null) {
      return err('REFRESH_FAILED' as const, { message: 'Malformed token response' });
    }
    const record: Record<string, unknown> = { ...data };
    const accessToken = typeof record.access_token === 'string' ? record.access_token : null;
    if (!accessToken) {
      return err('REFRESH_FAILED' as const, { message: 'Token response missing access_token' });
    }

    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 7200;
    return ok({
      accessToken,
      // Bitbucket usually echoes the same refresh token back; fall back to
      // the stored one when the response omits it.
      refreshToken:
        typeof record.refresh_token === 'string' && record.refresh_token
          ? record.refresh_token
          : refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}

/**
 * Bitbucket keeps its identity in the grant's `metadata` jsonb: the
 * username the web UI shows and API paths accept. Read defensively — the
 * column is provider-shaped, nothing guarantees the keys.
 */
export function readBitbucketMetadata(metadata: Record<string, unknown>): {
  username: string;
} {
  return {
    username: typeof metadata.username === 'string' ? metadata.username : '',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...value };
}
