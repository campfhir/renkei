/**
 * The GitHub App implementation of ProviderAdapter — a user-to-server
 * grant on Renkei's GitHub App.
 *
 * Unlike Bitbucket's OAuth consumer, a GitHub App's PERMISSIONS are fixed
 * on the app's own registration (contents, pull_requests, actions,
 * metadata, …) rather than requested as an OAuth scope string — there is
 * no `scope` parameter on the authorize URL at all. That makes this
 * adapter's shape closer to Bitbucket than to Atlassian's 3LO: the token
 * always carries whatever the App was configured with, and any narrowing
 * a person does in Renkei's own picker is enforced here, on our side,
 * never sent to GitHub (see github-scopes.ts and narrowedScopes).
 *
 * GitHub App user-to-server tokens expire (8h by default for every App
 * created since GitHub's 2022 rollout) and always come with a refresh
 * token (~6 months), so — unlike classic non-expiring OAuth Apps —
 * refreshing is not optional here.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';

export const GITHUB = 'github';

const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';

export class GitHubAdapter implements ProviderAdapter {
  readonly provider = GITHUB;

  constructor(private readonly clientSecret: string) {}

  async refreshTokens(
    clientId: string,
    refreshToken: string
  ): Promise<Result<RefreshedTokens, RefreshError>> {
    if (!this.clientSecret) {
      return err('REFRESH_FAILED' as const, {
        message: 'GitHub client secret is not configured',
      });
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
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
        // Bounded like every connector client: a stalled token endpoint must
        // not hang the caller's whole request path.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return err('REFRESH_FAILED' as const, {
        message: timedOut
          ? 'github.com token endpoint timed out after 15000ms'
          : 'Could not reach github.com',
      });
    }

    // GitHub answers a bad or expired refresh token with HTTP 200 and an
    // {error: "bad_refresh_token"} body, not a 4xx status — checked before
    // response.ok, which would otherwise read this as success.
    const data: unknown = await response.json().catch(() => null);
    const record = asRecord(data);
    if (typeof record.error === 'string' && record.error) {
      // "bad_refresh_token" is the one signal the refresh token is
      // genuinely dead; a client/app-level error (bad_verification_code,
      // incorrect_client_credentials, …) is ours to fix, not the grant's.
      if (record.error === 'bad_refresh_token') {
        return err('GRANT_REVOKED' as const);
      }
      return err('REFRESH_FAILED' as const, {
        message: `GitHub token refresh failed: ${record.error}`,
      });
    }
    if (!response.ok) {
      return err('REFRESH_FAILED' as const, {
        message: `GitHub token refresh failed (${response.status})`,
      });
    }

    const accessToken = typeof record.access_token === 'string' ? record.access_token : null;
    if (!accessToken) {
      return err('REFRESH_FAILED' as const, { message: 'Token response missing access_token' });
    }
    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 28_800;

    return ok({
      accessToken,
      // A refresh mints a NEW refresh token too (GitHub rotates it); fall
      // back to the one that was spent only if the response omitted it.
      refreshToken:
        typeof record.refresh_token === 'string' && record.refresh_token
          ? record.refresh_token
          : refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });
  }
}

/**
 * GitHub keeps identity in the grant's `metadata` jsonb: the login the
 * web UI shows and API paths accept.
 */
export function readGitHubMetadata(metadata: Record<string, unknown>): {
  login: string;
} {
  return {
    login: typeof metadata.login === 'string' ? metadata.login : '',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...value };
}
