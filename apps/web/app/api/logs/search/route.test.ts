/**
 * Tests for the activity-log locator.
 *
 * The renkei-user branch previously took an accountId from the query string and
 * checked only that a grant existed for it — "this account has a grant" is not
 * "the caller owns this account", so any user could read another user's logs.
 * These cases pin the replacement: a user's account id comes from their session,
 * never from what they send, and naming another account is refused.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/log-encryption', () => ({ resolveLogCipher: () => ({ state: 'off' }) }));
jest.mock('@/lib/log-query', () => ({ buildLogQueryOptions: jest.fn(() => ({})) }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { POST } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { buildLogQueryOptions: mockBuildQuery } = jest.requireMock<{
  buildLogQueryOptions: jest.Mock;
}>('@/lib/log-query');

/**
 * A memory store holding an Atlassian grant per entry (subject → account),
 * recording which subject the route asked about so a test can prove the
 * identity came from the session.
 */
async function stubStore(grants: Record<string, string>) {
  const asked: string[] = [];
  const store = createMemoryDataStore();
  await store.seed({
    provider_grants: Object.entries(grants).map(([subject, account]) => ({
      provider: 'atlassian',
      provider_account_id: account,
      subject,
      client_id: 'c',
      display_name: subject,
      encrypted_access_token: 'e',
      encrypted_refresh_token: 'e',
      expires_at: new Date(Date.now() + 60_000),
    })),
  });
  registerDataStore({
    ...store,
    personalAccount: {
      ...store.personalAccount,
      providerAccountId: (subject, provider) => {
        asked.push(subject);
        return store.personalAccount.providerAccountId(subject, provider);
      },
    },
  });
  return { asked };
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/logs${query}`, { method: 'POST' });
}

function session(subject: string, roles: string[]) {
  return {
    id: 'session-1',
    subject,
    roles,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe('POST /api/logs/search', () => {
  afterAll(() => {
    resetDataStore();
  });

  beforeEach(() => {
    mockGetSession.mockReset();
    mockBuildQuery.mockClear();
  });

  it('rejects a caller with no session', async () => {
    mockGetSession.mockResolvedValue(null);
    await stubStore({});

    const response = await POST(request('?accountId=acc-a'));

    expect(response.status).toBe(401);
  });

  it('refuses a user asking for another account, having looked up by session subject', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    const { asked } = await stubStore({
      'user-a@example.com': 'acc-a',
      'user-b@example.com': 'acc-b',
    });

    const response = await POST(request('?accountId=acc-b'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Cannot view other users logs' });
    // Identity came from the session, never from the query string.
    expect(asked).toEqual(['user-a@example.com']);
  });

  it('serves a user their own logs, scoped to their own account', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    await stubStore({ 'user-a@example.com': 'acc-a' });

    const response = await POST(request('?accountId=acc-a'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accountId).toBe('acc-a');
    expect(mockBuildQuery).toHaveBeenCalledWith(null, 'acc-a');
  });

  it('serves a user their own logs even with no accountId in the request', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    await stubStore({ 'user-a@example.com': 'acc-a' });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mockBuildQuery).toHaveBeenCalledWith(null, 'acc-a');
  });

  it('refuses a user with no grant', async () => {
    mockGetSession.mockResolvedValue(session('user-c@example.com', ['renkei-user']));
    await stubStore({ 'user-b@example.com': 'acc-b' });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'No Jira grant for this user' });
  });
});
