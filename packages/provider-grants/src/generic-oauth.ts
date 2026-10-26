/**
 * A ProviderAdapter for a provider nobody wrote an adapter for: the token
 * endpoint, the client and how it authenticates are all handed in. This is
 * what a remote MCP server gets — the endpoint came out of that server's own
 * authorization discovery, so it is data, not code.
 *
 * `invalid_grant` is the only verdict that deletes the grant (the
 * ProviderAdapter contract); everything else is a transient REFRESH_FAILED.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';
import { log } from '@renkei/logging';

export class GenericOAuthAdapter implements ProviderAdapter {
  constructor(
    readonly provider: string,
    private readonly tokenEndpoint: string,
    private readonly clientSecret: string,
    private readonly clientAuth: 'none' | 'basic' | 'body',
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (this.clientAuth === 'basic' && this.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(this.clientSecret)}`
      ).toString('base64')}`;
    } else {
      form.set('client_id', clientId);
      if (this.clientAuth === 'body' && this.clientSecret) {
        form.set('client_secret', this.clientSecret);
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      log.warn('Token refresh for {provider} could not reach the token endpoint: {message}', {
        component: 'provider-grants/generic-oauth',
        provider: this.provider,
        message: error instanceof Error ? error.message : String(error),
      });
      return err('REFRESH_FAILED' as const, { message: 'Could not reach the token endpoint' });
    }

    const data: unknown = await response.json().catch(() => null);
    const record: Record<string, unknown> =
      typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data } : {};
    if (!response.ok) {
      if (record.error === 'invalid_grant') return err('GRANT_REVOKED' as const);
      return err('REFRESH_FAILED' as const, {
        message: `Token refresh failed (${response.status})`,
      });
    }
    if (typeof record.access_token !== 'string' || !record.access_token) {
      return err('REFRESH_FAILED' as const, { message: 'Token response missing access_token' });
    }
    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;
    return ok({
      accessToken: record.access_token,
      refreshToken:
        typeof record.refresh_token === 'string' && record.refresh_token
          ? record.refresh_token
          : refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}
