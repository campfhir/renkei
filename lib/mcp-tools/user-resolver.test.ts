/**
 * Tests for email → accountId resolution.
 *
 * The cases that matter here are the ones that would go wrong quietly: taking
 * the first of several matches attributes a comment or an approval to the wrong
 * person, and a cache keyed on email alone hands one tenant's account id to
 * another tenant.
 */

jest.mock('./common', () => ({
  jiraFetch: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { jiraFetch } from './common';
import { resolveAccountId, searchUsers, looksLikeEmail, clearUserCache } from './user-resolver';

const mockJiraFetch = jest.mocked(jiraFetch);

interface FakeUser {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

/** Queue a single `/user/search` response. */
function respondWith(body: FakeUser[] | Record<string, unknown>): void {
  mockJiraFetch.mockResolvedValueOnce(new Response(JSON.stringify(body)));
}

const CONTEXT = {
  tenantId: 'tenant-a',
  apiBaseUrl: 'https://api.atlassian.com/ex/jira/cloud-1',
  accessToken: 'token-a',
};

describe('looksLikeEmail', () => {
  it('accepts an address and rejects an account id', () => {
    expect(looksLikeEmail('sam@example.com')).toBe(true);
    expect(looksLikeEmail('5b10a2844c20165700ede21g')).toBe(false);
    expect(looksLikeEmail('sam@example')).toBe(false);
    expect(looksLikeEmail('sam @example.com')).toBe(false);
  });
});

describe('searchUsers', () => {
  beforeEach(() => {
    mockJiraFetch.mockReset();
    clearUserCache();
  });

  it('keeps only the fields it declares, dropping foreign shapes', async () => {
    respondWith([
      { accountId: 'acc-1', displayName: 'Sam', emailAddress: 'sam@example.com' },
      // Jira omits emailAddress when profile visibility hides it.
      { accountId: 'acc-2', displayName: 'Ada' },
    ]);

    const users = await searchUsers(CONTEXT, 'sam');

    expect(users).toEqual([
      { accountId: 'acc-1', displayName: 'Sam', emailAddress: 'sam@example.com' },
      { accountId: 'acc-2', displayName: 'Ada' },
    ]);
  });

  it('returns nothing when the endpoint does not answer with an array', async () => {
    respondWith({ errorMessages: ['nope'] });

    await expect(searchUsers(CONTEXT, 'sam')).resolves.toEqual([]);
  });

  it('caps maxResults at the 50 the endpoint allows', async () => {
    respondWith([]);
    await searchUsers(CONTEXT, 'sam', 500);

    expect(mockJiraFetch).toHaveBeenCalledWith(expect.stringContaining('maxResults=50'), 'token-a');
  });
});

describe('resolveAccountId', () => {
  beforeEach(() => {
    mockJiraFetch.mockReset();
    clearUserCache();
  });

  it('passes an account id through without calling Jira', async () => {
    await expect(resolveAccountId(CONTEXT, '5b10a2844c20165700ede21g')).resolves.toBe(
      '5b10a2844c20165700ede21g'
    );
    expect(mockJiraFetch).not.toHaveBeenCalled();
  });

  it('resolves an email to the matching account id', async () => {
    respondWith([{ accountId: 'acc-1', displayName: 'Sam', emailAddress: 'sam@example.com' }]);

    await expect(resolveAccountId(CONTEXT, 'sam@example.com')).resolves.toBe('acc-1');
  });

  it('ignores substring near-misses that are not the exact address', async () => {
    // Jira's search matches on fragments, so querying sam@example.com can
    // return sam@example.com.au.
    respondWith([
      { accountId: 'acc-9', displayName: 'Other Sam', emailAddress: 'sam@example.com.au' },
    ]);

    await expect(resolveAccountId(CONTEXT, 'sam@example.com')).rejects.toThrow(
      /No Jira user found with email sam@example\.com/
    );
  });

  it('explains that a hidden email cannot be matched', async () => {
    respondWith([{ accountId: 'acc-2', displayName: 'Ada' }]);

    await expect(resolveAccountId(CONTEXT, 'ada@example.com')).rejects.toThrow(
      /profile visibility settings/
    );
  });

  it('refuses to guess when more than one user has the address', async () => {
    respondWith([
      { accountId: 'acc-1', emailAddress: 'sam@example.com' },
      { accountId: 'acc-2', emailAddress: 'SAM@example.com' },
    ]);

    await expect(resolveAccountId(CONTEXT, 'sam@example.com')).rejects.toThrow(
      /matched 2 Jira users[\s\S]*acc-1, acc-2/
    );
  });

  it('serves a repeat lookup from cache', async () => {
    respondWith([{ accountId: 'acc-1', emailAddress: 'sam@example.com' }]);

    await resolveAccountId(CONTEXT, 'sam@example.com');
    await resolveAccountId(CONTEXT, 'sam@example.com');

    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
  });

  it('matches the cache case-insensitively, as email addresses are', async () => {
    respondWith([{ accountId: 'acc-1', emailAddress: 'sam@example.com' }]);

    await resolveAccountId(CONTEXT, 'sam@example.com');
    await expect(resolveAccountId(CONTEXT, 'SAM@Example.com')).resolves.toBe('acc-1');
    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
  });

  it('does not serve one tenant the account id resolved for another', async () => {
    const tenantB = { ...CONTEXT, tenantId: 'tenant-b', accessToken: 'token-b' };

    respondWith([{ accountId: 'acc-tenant-a', emailAddress: 'sam@example.com' }]);
    await expect(resolveAccountId(CONTEXT, 'sam@example.com')).resolves.toBe('acc-tenant-a');

    // Same person, different Jira site, different account id.
    respondWith([{ accountId: 'acc-tenant-b', emailAddress: 'sam@example.com' }]);
    await expect(resolveAccountId(tenantB, 'sam@example.com')).resolves.toBe('acc-tenant-b');

    expect(mockJiraFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    respondWith([]);
    await expect(resolveAccountId(CONTEXT, 'sam@example.com')).rejects.toThrow();

    respondWith([{ accountId: 'acc-1', emailAddress: 'sam@example.com' }]);
    await expect(resolveAccountId(CONTEXT, 'sam@example.com')).resolves.toBe('acc-1');
  });

  it('re-resolves once the cached entry expires', async () => {
    jest.useFakeTimers();
    try {
      respondWith([{ accountId: 'acc-1', emailAddress: 'sam@example.com' }]);
      await resolveAccountId(CONTEXT, 'sam@example.com');

      jest.advanceTimersByTime(60 * 60 * 1000 + 1);

      respondWith([{ accountId: 'acc-1-rotated', emailAddress: 'sam@example.com' }]);
      await expect(resolveAccountId(CONTEXT, 'sam@example.com')).resolves.toBe('acc-1-rotated');
      expect(mockJiraFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
