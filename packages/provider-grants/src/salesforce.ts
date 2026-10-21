/**
 * The Salesforce implementation of ProviderAdapter — a person's grant on the
 * organization's own External Client App (or connected app), in its own
 * Salesforce org.
 *
 * Two Salesforce shapes the generic lifecycle must absorb:
 *
 *  - The token endpoint is the ORG's (its My Domain,
 *    `https://<domain>.my.salesforce.com/services/oauth2/token`), not a
 *    fixed Salesforce host, so the adapter is built with it.
 *  - The token response carries `issued_at` and no `expires_in`: a session
 *    lasts as long as the org's session timeout for that app, which the
 *    response does not say. The grant records an hour (SESSION_SECONDS) —
 *    shorter than Salesforce's two-hour default, so a refresh comes early
 *    rather than late — and the delegate's refresh-and-retry on a 401 covers
 *    an org whose timeout is shorter still.
 *
 * Refresh tokens do not rotate by default; when the org turns rotation on,
 * the response carries a new one and it replaces the old.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

/** The CRM connector's grant provider. */
export const SALESFORCE = 'salesforce';

/** How long a Salesforce access token is assumed to live; see the header. */
export const SALESFORCE_SESSION_SECONDS = 3600;

export class SalesforceAdapter implements ProviderAdapter {
  constructor(
    private readonly clientSecret: string,
    private readonly tokenEndpoint: string,
    readonly provider: string = SALESFORCE
  ) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret || !this.tokenEndpoint) {
      return err('REFRESH_FAILED' as const, {
        message: 'Salesforce client secret or My Domain is not configured',
      });
    }

    let response: Response;
    try {
      response = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: this.clientSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('REFRESH_FAILED' as const, {
        message: timedOut
          ? 'Salesforce token endpoint timed out after 15000ms'
          : 'Could not reach the Salesforce token endpoint',
      });
    }

    const record = asRecord(await response.json().catch(() => null));
    if (!response.ok) {
      // invalid_grant is Salesforce's word for a refresh token that is dead:
      // revoked, expired under the app's refresh token policy, or its user
      // deactivated. Anything else (a wrong secret, an app turned off) is
      // the configuration's to fix, not the grant's.
      if (record.error === 'invalid_grant') return err('GRANT_REVOKED' as const);
      return err('REFRESH_FAILED' as const, {
        message: `Salesforce token refresh failed (${response.status}${
          typeof record.error === 'string' ? `: ${record.error}` : ''
        })`,
      });
    }

    const accessToken = typeof record.access_token === 'string' ? record.access_token : null;
    if (!accessToken) {
      return err('REFRESH_FAILED' as const, { message: 'Token response missing access_token' });
    }
    const expiresIn =
      typeof record.expires_in === 'number' ? record.expires_in : SALESFORCE_SESSION_SECONDS;

    return ok({
      accessToken,
      refreshToken:
        typeof record.refresh_token === 'string' && record.refresh_token
          ? record.refresh_token
          : refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}

/** The token endpoint of an org, from its My Domain origin. */
export function salesforceTokenEndpoint(myDomainOrigin: string): string {
  return `${myDomainOrigin.replace(/\/+$/, '')}/services/oauth2/token`;
}

/** The revoke endpoint of an org, from its My Domain origin. */
export function salesforceRevokeEndpoint(myDomainOrigin: string): string {
  return `${myDomainOrigin.replace(/\/+$/, '')}/services/oauth2/revoke`;
}

/**
 * What a Salesforce grant keeps in `metadata`: the org and user it belongs
 * to, the instance it was minted for, and the names the card shows.
 */
export function readSalesforceMetadata(metadata: Record<string, unknown>): {
  orgId: string;
  userId: string;
  instanceUrl: string;
  username: string;
} {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    orgId: str(metadata.orgId),
    userId: str(metadata.userId),
    instanceUrl: str(metadata.instanceUrl),
    username: str(metadata.username),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...value };
}
