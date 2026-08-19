/**
 * Tests for the session list/revoke route.
 *
 * The renkei-user branches previously took an accountId from the query string
 * and checked only that a grant existed for it, so any user could list another
 * user's sessions (GET) or revoke them (DELETE) by naming their id. These cases
 * pin the replacement: the caller's account is derived from their session, and
 * a target that is not their own is refused.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/audit', () => ({
  getUserSessions: jest.fn(async () => ({ ok: true, val: [] })),
  revokeSession: jest.fn(async () => ({ ok: true, val: undefined })),
}));

import { NextRequest } from 'next/server';
import { GET, DELETE } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { getUserSessions: mockGetUserSessions, revokeSession: mockRevokeSession } =
  jest.requireMock<{ getUserSessions: jest.Mock; revokeSession: jest.Mock }>('@/lib/audit');

const TENANT = '00000000-0000-4000-8000-000000000001';

/**
 * Table-aware stub. `tenants` always resolves. `provider_grants` resolves to
 * `grant` and records its where-filters (to prove identity came from the
 * session). `jira_sessions` resolves to `targetSession`.
 */
function stubDb(opts: {
  grant?: Record<string, unknown>;
  targetSession?: Record<string, unknown>;
}) {
  const grantFilters: Array<[string, string, unknown]> = [];
  const chainFor = (row: unknown, record: boolean) => {
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
      selectFrom: (table: string) => {
        if (table === 'tenants') return chainFor({ id: TENANT }, false);
        if (table === 'jira_sessions') return chainFor(opts.targetSession, false);
        return chainFor(opts.grant, true); // provider_grants
      },
    },
  });
  return { grantFilters };
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

describe('GET /api/tenant/{tenantId}/sessions', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
    mockGetUserSessions.mockClear();
  });

  it('lists a user their own sessions, derived from their session subject', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    const { grantFilters } = stubDb({ grant: { provider_account_id: 'acc-a' } });

    // Name someone else's account; it must be ignored in favour of acc-a.
    const req = new NextRequest(`http://localhost/api/tenant/${TENANT}/sessions?accountId=acc-b`);
    const response = await GET(req, params());

    // acc-b !== acc-a, so this is refused rather than served under the wrong id.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Cannot view other users sessions' });
    expect(grantFilters).toContainEqual(['subject', '=', 'user-a@example.com']);
  });

  it('serves own sessions when no accountId is supplied', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    stubDb({ grant: { provider_account_id: 'acc-a' } });

    const req = new NextRequest(`http://localhost/api/tenant/${TENANT}/sessions`);
    const response = await GET(req, params());

    expect(response.status).toBe(200);
    expect(mockGetUserSessions).toHaveBeenCalledWith(TENANT, 'acc-a');
  });
});

describe('DELETE /api/tenant/{tenantId}/sessions', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
    mockRevokeSession.mockClear();
  });

  it("refuses to revoke another user's session", async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    // Caller owns acc-a; the target session belongs to acc-b.
    stubDb({
      grant: { provider_account_id: 'acc-a' },
      targetSession: { id: 'sess-x', accountId: 'acc-b' },
    });

    const req = new NextRequest(
      `http://localhost/api/tenant/${TENANT}/sessions?sessionId=sess-x&accountId=acc-b`,
      { method: 'DELETE' }
    );
    const response = await DELETE(req, params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Cannot revoke other users sessions' });
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it('revokes the caller’s own session', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    stubDb({
      grant: { provider_account_id: 'acc-a' },
      targetSession: { id: 'sess-own', accountId: 'acc-a' },
    });

    const req = new NextRequest(
      `http://localhost/api/tenant/${TENANT}/sessions?sessionId=sess-own`,
      { method: 'DELETE' }
    );
    const response = await DELETE(req, params());

    expect(response.status).toBe(200);
    expect(mockRevokeSession).toHaveBeenCalledWith('sess-own', TENANT);
  });
});
