/**
 * Resolves email addresses to Jira cloud IDs (accountIds).
 *
 * When a tool user specifies an email address instead of an account ID,
 * this module searches Jira for the matching user and caches the result
 * to avoid repeated lookups.
 */

import type { JiraClient } from './client.js';

export interface UserSearchResult {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

interface CacheEntry {
  cloudId: string;
  displayName?: string;
  cachedAt: number;
}

const CACHE_TTL_MS = 3600000; // 1 hour

export class UserResolver {
  readonly #client: JiraClient;
  readonly #cache: Map<string, CacheEntry>;

  constructor(client: JiraClient) {
    this.#client = client;
    this.#cache = new Map();
  }

  /**
   * Resolves an email or account ID to a cloud ID.
   * If input looks like an email, searches for it. Otherwise returns as-is.
   */
  async resolve(emailOrAccountId: string): Promise<string> {
    if (!this.#looksLikeEmail(emailOrAccountId)) {
      return emailOrAccountId;
    }

    const cached = this.#cache.get(emailOrAccountId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.cloudId;
    }

    const cloudId = await this.#searchForUser(emailOrAccountId);
    this.#cache.set(emailOrAccountId, {
      cloudId,
      cachedAt: Date.now(),
    });

    return cloudId;
  }

  /** Clears the cache. Useful for testing or manual cache invalidation. */
  clearCache(): void {
    this.#cache.clear();
  }

  /**
   * Raw name/email search, for a tool call rather than the internal
   * email→accountId resolution `resolve()` does. Unlike `resolve()`, this
   * accepts a partial name and returns every match rather than assuming the
   * first result is the right one.
   */
  async search(query: string): Promise<UserSearchResult[]> {
    const results = await this.#client.get<UserSearchResult[]>('/rest/api/3/user/search', {
      query: { query },
    });

    return Array.isArray(results) ? results : [];
  }

  #looksLikeEmail(input: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
  }

  async #searchForUser(email: string): Promise<string> {
    const results = await this.search(email);

    if (results.length === 0) {
      throw new Error(`No Jira user found with email ${email}`);
    }

    const user = results[0];
    if (!user || !user.accountId) {
      throw new Error(`User found for ${email} but has no accountId`);
    }

    return user.accountId;
  }
}
