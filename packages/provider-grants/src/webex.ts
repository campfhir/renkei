/**
 * The WebEx user-integration implementation of ProviderAdapter.
 *
 * Distinct from the WebEx *bot* connector: the bot is one org credential that
 * watches spaces it is invited to, while this grant is a user's own OAuth
 * authorization ("Renkei acts as me"), able to read whatever rooms that user
 * is in. Same split as Atlassian — org app registration in connector config,
 * per-user grant rows here.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const WEBEX_USER = 'webex';

const TOKEN_ENDPOINT = 'https://webexapis.com/v1/access_token';

export class WebexUserAdapter implements ProviderAdapter {
  readonly provider = WEBEX_USER;

  constructor(private readonly clientSecret: string) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret) {
      return err('REFRESH_FAILED' as const, { message: 'WebEx client secret is not configured' });
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken,
        }),
      });
    } catch {
      return err('REFRESH_FAILED' as const, { message: 'Could not reach webexapis.com' });
    }

    if (!response.ok) {
      // WebEx answers 400 with invalid_grant when the refresh token itself is
      // dead — the only signal on which the lifecycle may delete the grant.
      const body = await response.text().catch(() => '');
      if (response.status === 400 && body.includes('invalid_grant')) {
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const, {
        message: `WebEx token refresh failed (${response.status})`,
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

    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;
    return ok({
      accessToken,
      // WebEx keeps the refresh token stable across refreshes (its lifetime
      // resets on use); a rotated one would arrive here and be stored.
      refreshToken:
        typeof record.refresh_token === 'string' && record.refresh_token
          ? record.refresh_token
          : refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}
