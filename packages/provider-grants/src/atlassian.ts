/**
 * The Atlassian implementation of ProviderAdapter — the first, and the
 * template for the next one. Everything Atlassian-specific about token
 * refresh lives here; the generic lifecycle neither knows nor cares that
 * the endpoint is auth.atlassian.com.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const ATLASSIAN = 'atlassian';

const TOKEN_ENDPOINT = 'https://auth.atlassian.com/oauth/token';

/**
 * Atlassian keeps its site identity in the grant's `metadata` jsonb. Read it
 * defensively: the column is provider-shaped, so nothing in the schema
 * guarantees these keys are present on a given row.
 */
export function readAtlassianMetadata(metadata: Record<string, unknown>): {
  cloudId: string;
  siteUrl: string;
} {
  return {
    cloudId: typeof metadata.cloudId === 'string' ? metadata.cloudId : '',
    siteUrl: typeof metadata.siteUrl === 'string' ? metadata.siteUrl : '',
  };
}

export class AtlassianAdapter implements ProviderAdapter {
  readonly provider = ATLASSIAN;

  // client_secret is required for the refresh_token grant, same as the initial
  // code exchange. Omitting it yields 401 access_denied / "Unauthorized".
  constructor(private readonly clientSecret: string) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret) {
      return err('REFRESH_FAILED' as const, {
        message: 'ATLASSIAN_CLIENT_SECRET is not configured',
      });
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
        }),
      });
    } catch {
      return err('REFRESH_FAILED' as const, { message: 'token endpoint unreachable' });
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      const record = asRecord(body);
      // Only invalid_grant means the refresh token is genuinely dead. Every
      // other failure (client auth, network, 5xx) is ours to fix — reporting
      // it as revoked would make the orchestrator destroy a working grant.
      if (record.error === 'invalid_grant') {
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const, {
        message: `token endpoint returned ${response.status}`,
      });
    }

    const data: unknown = await response.json().catch(() => null);
    const record = asRecord(data);
    const accessToken = record.access_token;
    const refreshedToken = record.refresh_token;
    if (typeof accessToken !== 'string' || typeof refreshedToken !== 'string') {
      return err('REFRESH_FAILED' as const, {
        message: 'token response missing access_token or refresh_token',
      });
    }
    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;

    return ok({
      accessToken,
      refreshToken: refreshedToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...value };
}
