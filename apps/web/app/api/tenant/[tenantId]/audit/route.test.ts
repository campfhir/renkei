/**
 * Tests for the audit log locator.
 *
 * The route previously took an accountId from the query string and checked
 * only that a grant existed for it, with no session at all. The cases below
 * pin the two properties that replaced that: a caller must be authenticated,
 * and a non-operator's identity comes from their session rather than from
 * anything they send.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const TENANT = '00000000-0000-4000-8000-000000000001';

interface Recorded {
  filters: Array<[string, string, unknown]>;
}

function stubDb(row: Record<string, unknown> | undefined) {
  const recorded: Recorded = { filters: [] };
  const chain = {
    select() {
      return chain;
    },
    where(column: string, op: string, value: unknown) {
      recorded.filters.push([column, op, value]);
      return chain;
    },
    async executeTakeFirst() {
      return row;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: { selectFrom: () => chain } });
  return recorded;
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/tenant/${TENANT}/audit${query}`);
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

describe('GET /api/tenant/{tenantId}/audit', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
  });

  it('rejects a caller with no session', async () => {
    mockGetSession.mockResolvedValue(null);
    stubDb(undefined);

    const response = await GET(request('?accountId=acc-a'), params());

    expect(response.status).toBe(401);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('ignores an x-operator-key header, which is no longer an auth mechanism', async () => {
    mockGetSession.mockResolvedValue(null);
    stubDb(undefined);

    const headed = new NextRequest(`http://localhost/api/tenant/${TENANT}/audit`, {
      headers: { 'x-operator-key': 'anything' },
    });
    const response = await GET(headed, params());

    expect(response.status).toBe(401);
  });

  it('gives an operator the tenant-wide log context', async () => {
    mockGetSession.mockResolvedValue(session('op@example.com', ['renkei-operator']));
    stubDb(undefined);

    const body = await (await GET(request(), params())).json();

    expect(body.role).toBe('renkei-operator');
    expect(body.logContext).toBe(`mcp:${TENANT}`);
  });

  it("derives a user's account id from their session, not the query string", async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    const recorded = stubDb({ provider_account_id: 'acc-a' });

    const body = await (await GET(request(), params())).json();

    expect(recorded.filters).toEqual([
      ['tenant_id', '=', TENANT],
      ['provider', '=', 'atlassian'],
      ['subject', '=', 'user-a@example.com'],
    ]);
    expect(body.accountId).toBe('acc-a');
    expect(body.logContext).toBe(`mcp:${TENANT}:acc-a`);
  });

  it('refuses a user asking for another account', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    stubDb({ provider_account_id: 'acc-a' });

    const response = await GET(request('?accountId=acc-b'), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Cannot view other users audit logs',
    });
  });

  it('allows a user naming their own account', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    stubDb({ provider_account_id: 'acc-a' });

    const response = await GET(request('?accountId=acc-a'), params());

    expect(response.status).toBe(200);
  });

  it('refuses a user with no grant', async () => {
    mockGetSession.mockResolvedValue(session('user-c@example.com', ['renkei-user']));
    stubDb(undefined);

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
  });

  it('refuses a session carrying no recognised role', async () => {
    mockGetSession.mockResolvedValue(session('nobody@example.com', []));
    stubDb({ provider_account_id: 'acc-a' });

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid user role' });
  });
});
