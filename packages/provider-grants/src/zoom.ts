/**
 * The Zoom implementation of ProviderAdapter.
 *
 * Zoom's token endpoint authenticates the app with HTTP Basic (client id and
 * secret in the Authorization header), not with credentials in the form body
 * like Atlassian/WebEx. Zoom also ROTATES refresh tokens: every successful
 * refresh returns a new refresh_token (each good for ~90 days), so the
 * rotated token must always be returned for storage — reusing the old one
 * after a rotation is how a Zoom grant quietly dies.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const ZOOM = 'zoom';

const TOKEN_ENDPOINT = 'https://zoom.us/oauth/token';

export class ZoomAdapter implements ProviderAdapter {
  readonly provider = ZOOM;

  constructor(private readonly clientSecret: string) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret) {
      return err('REFRESH_FAILED' as const, { message: 'Zoom client secret is not configured' });
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
        message: timedOut ? 'zoom.us token endpoint timed out after 15000ms' : 'Could not reach zoom.us',
      });
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      const record = asRecord(body);
      // Zoom reports errors as {"error": "..."} or {"reason": "..."}. Only an
      // EXPLICIT invalid_grant in either field means the refresh token is
      // dead — the one signal on which the lifecycle may delete the grant.
      // Ambiguous prose like "Invalid Token!" stays REFRESH_FAILED: deleting
      // on a guess would destroy a working authorization.
      if (record.error === 'invalid_grant' || record.reason === 'invalid_grant') {
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const, {
        message: `Zoom token refresh failed (${response.status})`,
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
      // Zoom rotates the refresh token on every refresh; fall back to the old
      // one only if the response omits it.
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
