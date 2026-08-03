/**
 * Hands out a currently-valid Atlassian access token, refreshing when the one
 * on hand is close to expiry.
 *
 * Two things this must get right:
 *
 *   1. Atlassian rotates the refresh token on every use. The rotated token is
 *      persisted before it is returned, so a crash between refresh and save
 *      cannot strand the grant.
 *   2. Concurrent tool calls must not each fire a refresh. A single in-flight
 *      promise is shared; the losers await the winner's result. (Atlassian's
 *      10-minute reuse interval would forgive a small race, but relying on
 *      that is not a design.)
 */

import type { AtlassianConfig } from '@/lib/config';
import { refreshAccessToken, type FetchLike } from './atlassian.js';
import type { Grant, TokenStore } from './token-store.js';
import { withRetry } from '@/lib/util/retry';

/** Refresh this far ahead of expiry so an in-flight request never races it. */
const DEFAULT_REFRESH_SKEW_SECONDS = 120;

export class MissingGrantError extends Error {
  constructor(message = 'No Atlassian grant found. Run `pnpm auth` to authorize.') {
    super(message);
    this.name = 'MissingGrantError';
  }
}

export class SitePinningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SitePinningError';
  }
}

export interface TokenProviderOptions {
  store: TokenStore;
  atlassian: AtlassianConfig;
  fetchImpl?: FetchLike;
  now?: () => number;
  refreshSkewSeconds?: number;
}

export class TokenProvider {
  readonly #store: TokenStore;
  readonly #atlassian: AtlassianConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #skewMs: number;

  #cached: Grant | null = null;
  #inflight: Promise<Grant> | null = null;

  constructor(options: TokenProviderOptions) {
    this.#store = options.store;
    this.#atlassian = options.atlassian;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#skewMs = (options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;
  }

  async getAccessToken(): Promise<string> {
    const grant = await this.getGrant();
    return grant.accessToken;
  }

  async getGrant(): Promise<Grant> {
    const grant = this.#cached ?? (await this.#load());

    if (!this.#isExpiring(grant)) {
      return grant;
    }

    return this.#refreshOnce(grant);
  }

  /** Refreshes regardless of expiry. Used by the auth CLI to prove rotation works. */
  async forceRefresh(): Promise<Grant> {
    const grant = this.#cached ?? (await this.#load());
    return this.#refreshOnce(grant, true);
  }

  async #load(): Promise<Grant> {
    const grant = await this.#store.read();

    if (!grant) {
      throw new MissingGrantError();
    }
    if (grant.cloudId !== this.#atlassian.cloudId) {
      throw new SitePinningError(
        `stored grant is for cloud ID ${grant.cloudId} but ATLASSIAN_CLOUD_ID is ` +
          `${this.#atlassian.cloudId} — re-run \`pnpm auth\``,
      );
    }

    this.#cached = grant;
    return grant;
  }

  #isExpiring(grant: Grant): boolean {
    const expiresAt = Date.parse(grant.expiresAt);

    // An unparseable expiry is treated as expired rather than as valid forever.
    if (Number.isNaN(expiresAt)) {
      return true;
    }

    return expiresAt - this.#now() <= this.#skewMs;
  }

  #refreshOnce(grant: Grant, force = false): Promise<Grant> {
    // A refresh started by an earlier caller satisfies this one too.
    // On success or failure, clear the in-flight promise so the next caller
    // can either use the new token or attempt a fresh refresh.
    this.#inflight ??= this.#doRefresh(grant, force).finally(() => {
      this.#inflight = null;
    });

    return this.#inflight;
  }

  async #doRefresh(grant: Grant, force: boolean): Promise<Grant> {
    // Another caller may have already refreshed while this one was queued.
    if (!force && this.#cached && !this.#isExpiring(this.#cached)) {
      return this.#cached;
    }

    try {
      const tokens = await withRetry(
        () => refreshAccessToken(this.#atlassian, grant.refreshToken, this.#fetch),
        { maxAttempts: 3, initialDelayMs: 200 },
      );

      const refreshed: Grant = {
        ...grant,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : grant.scopes,
        updatedAt: new Date(this.#now()).toISOString(),
      };

      // Persist before returning: the old refresh token is now spent.
      await this.#store.write(refreshed);
      this.#cached = refreshed;

      return refreshed;
    } catch (error) {
      // Clear the cache on failure so a subsequent retry reads a fresh grant
      // from storage. This prevents the cache from holding an expired token.
      this.#cached = null;
      throw error;
    }
  }
}
