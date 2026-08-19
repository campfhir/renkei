/**
 * Tests for the activity-log locator.
 *
 * The renkei-user branch previously took an accountId from the query string and
 * checked only that a grant existed for it — "this account has a grant" is not
 * "the caller owns this account", so any user could read another user's logs.
 * These cases pin the replacement: a user's account id comes from their session,
 * never from what they send, and naming another account is refused.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/log-encryption', () => ({ resolveLogCipher: () => ({ state: 'off' }) }));
jest.mock('@/lib/log-query', () => ({ buildLogQueryOptions: jest.fn(() => ({})) }));
jest.mock('@campfhir/bored-logs/adapters/psql', () => ({
  PostgresAdapter: jest.fn().mockImplementation(() => ({
    query: async () => ({ ok: true, val: [] }),
  })),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { buildLogQueryOptions: mockBuildQuery } = jest.requireMock<{
  buildLogQueryOptions: jest.Mock;
}>('@/lib/log-query');

const TENANT = '00000000-0000-4000-8000-000000000001';

/**
 * Table-aware stub: `tenants` always resolves (the route checks existence
 * first), and `provider_grants` resolves to `grantRow`. Every `where(...)` on
 * the grant chain is recorded so a test can prove which identity was queried.
 */
function stubDb(grantRow: Record<string, unknown> | undefined) {
  const grantFilters: Array<[string, string, unknown]> = [];
  const makeChain = (row: unknown, record: boolean) => {
    const chain = {
      select: () => chain,
      where(column: string, op: string, value: unknown) {
        if (record) grantFilters.push([column, op, value]);
        return chain;
      },
      executeTakeFirst: async () => row,
    };
    return chain;
  };
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: (table: string) =>
        table === 'tenants' ? makeChain({ id: TENANT }, false) : makeChain(grantRow, true),
    },
  });
  return { grantFilters };
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/tenant/${TENANT}/logs${query}`, { method: 'POST' });
}

function params() {
  return { params: Promise.resolve({ tenantId: TENANT }) };
}

function session(subject: string, roles: string[]) {
  return {
    id: 'session-1',
    tenantId: TENANT,
    subject,
    roles,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe('POST /api/tenant/{tenantId}/logs', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
    mockBuildQuery.mockClear();
  });

  it('rejects a caller with no session', async () => {
    mockGetSession.mockResolvedValue(null);
    stubDb(undefined);

    const response = await POST(request('?accountId=acc-a'), params());

    expect(response.status).toBe(401);
  });

  it('refuses a user asking for another account, having looked up by session subject', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    const { grantFilters } = stubDb({ id: TENANT, provider_account_id: 'acc-a' });

    const response = await POST(request('?accountId=acc-b'), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Cannot view other users logs' });
    // Identity came from the session, never from the query string.
    expect(grantFilters).toContainEqual(['subject', '=', 'user-a@example.com']);
    expect(grantFilters).not.toContainEqual(['provider_account_id', '=', 'acc-b']);
  });

  it('serves a user their own logs, scoped to their own account', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    stubDb({ id: TENANT, provider_account_id: 'acc-a' });

    const response = await POST(request('?accountId=acc-a'), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accountId).toBe('acc-a');
    expect(mockBuildQuery).toHaveBeenCalledWith(null, TENANT, 'acc-a');
  });

  it('serves a user their own logs even with no accountId in the request', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    stubDb({ id: TENANT, provider_account_id: 'acc-a' });

    const response = await POST(request(), params());

    expect(response.status).toBe(200);
    expect(mockBuildQuery).toHaveBeenCalledWith(null, TENANT, 'acc-a');
  });

  it('refuses a user with no grant', async () => {
    mockGetSession.mockResolvedValue(session('user-c@example.com', ['renkei-user']));
    stubDb(undefined);

    const response = await POST(request(), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'No Jira grant for this user' });
  });
});
