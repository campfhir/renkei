/**
 * The Microsoft (Entra ID) implementation of ProviderAdapter.
 *
 * Refresh goes to the tenant-scoped v2.0 token endpoint — single-tenant app
 * registrations reject the `common` authority, so the directory (tenant) id
 * is part of the adapter's configuration, not of the per-grant row. Unlike
 * Atlassian, the endpoint speaks form-encoding, and unlike WebEx, Microsoft
 * ROTATES the refresh token on every use: the new one must be persisted or
 * the grant dies at the next refresh.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const MICROSOFT = 'microsoft';

export class MicrosoftAdapter implements ProviderAdapter {
  readonly provider = MICROSOFT;

  constructor(
    private readonly clientSecret: string,
    private readonly directoryTenantId: string
  ) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret) {
      return err('REFRESH_FAILED' as const, {
        message: 'Microsoft client secret is not configured',
      });
    }
    if (!this.directoryTenantId) {
      return err('REFRESH_FAILED' as const, {
        message: 'Microsoft directory (tenant) id is not configured',
      });
    }

    let response: Response;
    try {
      response = await fetch(
        `https://login.microsoftonline.com/${this.directoryTenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: this.clientSecret,
            refresh_token: refreshToken,
          }),
        }
      );
    } catch {
      return err('REFRESH_FAILED' as const, { message: 'token endpoint unreachable' });
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      const record = asRecord(body);
      // Only invalid_grant means the refresh token is genuinely dead (revoked,
      // expired, or family-invalidated). Everything else — invalid_client,
      // consent errors, 5xx — is ours to fix; reporting it as revoked would
      // make the orchestrator destroy a working grant.
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
    if (typeof accessToken !== 'string' || !accessToken) {
      return err('REFRESH_FAILED' as const, {
        message: 'token response missing access_token',
      });
    }
    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;

    return ok({
      accessToken,
      // Microsoft rotates refresh tokens: the response carries the successor
      // and the old one is invalidated. Persist the new one; fall back to the
      // old only if the response omits it (spec-legal, rare in practice).
      refreshToken:
        typeof record.refresh_token === 'string' && record.refresh_token
          ? record.refresh_token
          : refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...value };
}
