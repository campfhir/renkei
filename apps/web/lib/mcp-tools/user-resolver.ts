/**
 * Resolves email addresses to Atlassian account IDs.
 *
 * Several Jira and JSM endpoints accept only an `accountId`, never an email
 * address. Asking a tool caller to supply one is hostile — they are talking
 * about a colleague, and they know the email. This resolves an email to an
 * account ID on their behalf and caches the answer.
 *
 * A note on naming: an *account ID* identifies a person
 * (`5b10a2844c20165700ede21g`); a *cloud ID* identifies a Jira site and is what
 * appears in `https://api.atlassian.com/ex/jira/{cloudId}`. They are unrelated,
 * and this module deals only in account IDs.
 */

import { jiraFetch } from './common';
import { logger } from '@/lib/logger';

export interface UserSearchResult {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

interface CacheEntry {
  accountId: string;
  displayName?: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Keyed by `${tenantId}:${lowercased email}` rather than by email alone.
 * Each tenant authorises against its own Jira site, and the same person can
 * hold different account IDs on different sites — a global email key would
 * serve one tenant's account ID to another.
 */
const accountIdCache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, email: string): string {
  return `${tenantId}:${email.toLowerCase()}`;
}

export function looksLikeEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

/** Clear resolved account IDs. Exposed for tests and manual invalidation. */
export function clearUserCache(): void {
  accountIdCache.clear();
}

interface ResolverContext {
  tenantId: string;
  apiBaseUrl: string;
  accessToken: string;
}

/**
 * Raw name/email search. Unlike `resolveAccountId`, this accepts a partial name
 * and returns every match rather than assuming the first result is the right
 * person.
 */
export async function searchUsers(
  context: ResolverContext,
  query: string,
  maxResults = 50
): Promise<UserSearchResult[]> {
  const response = await jiraFetch(
    `${context.apiBaseUrl}/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${Math.min(maxResults, 50)}`,
    context.accessToken
  );

  const results: unknown = await response.json();
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record: Record<string, unknown> = { ...entry };
    const user: UserSearchResult = {};
    if (typeof record.accountId === 'string') user.accountId = record.accountId;
    if (typeof record.displayName === 'string') user.displayName = record.displayName;
    if (typeof record.emailAddress === 'string') user.emailAddress = record.emailAddress;
    return [user];
  });
}

/**
 * Resolve an email address to an account ID. Input that is not an email is
 * returned unchanged, so callers can accept either form in one parameter.
 *
 * Throws when an email matches no user, or matches more than one: silently
 * taking the first hit would attribute a comment, an approval, or a service
 * desk removal to the wrong person.
 */
export async function resolveAccountId(
  context: ResolverContext,
  emailOrAccountId: string
): Promise<string> {
  if (!looksLikeEmail(emailOrAccountId)) {
    return emailOrAccountId;
  }

  const key = cacheKey(context.tenantId, emailOrAccountId);
  const cached = accountIdCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accountId;
  }
  accountIdCache.delete(key);

  const results = await searchUsers(context, emailOrAccountId);

  // Jira's user search is a substring match over several fields, so an email
  // can return near-misses. Keep only exact address matches.
  const exact = results.filter(
    (u) => u.emailAddress?.toLowerCase() === emailOrAccountId.toLowerCase() && u.accountId
  );

  if (exact.length === 0) {
    // A user with a hidden email address cannot be matched this way, which is
    // worth saying plainly rather than reporting "no such user".
    throw new Error(
      `No Jira user found with email ${emailOrAccountId}. ` +
        `The address may be hidden by that user's profile visibility settings — ` +
        `use jira_search_users to find their accountId directly.`
    );
  }

  if (exact.length > 1) {
    throw new Error(
      `Email ${emailOrAccountId} matched ${exact.length} Jira users. ` +
        `Pass an accountId explicitly: ${exact.map((u) => u.accountId).join(', ')}`
    );
  }

  const user = exact[0];
  const accountId = user.accountId;
  if (!accountId) {
    throw new Error(`User found for ${emailOrAccountId} but the result carried no accountId`);
  }

  accountIdCache.set(key, {
    accountId,
    displayName: user.displayName,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  logger.debug('Resolved email to accountId', {
    component: 'jira/user-resolver',
    tenantId: context.tenantId,
    accountId,
  });

  return accountId;
}
