/**
 * Tests for the audit log locator.
 *
 * The route previously took an accountId from the query string and checked
 * only that a grant existed for it, with no session at all. The cases below
 * pin the two properties that replaced that: a caller must be authenticated,
 * and a non-operator's identity comes from their session rather than from
 * anything they send.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

function grant(provider: string, accountId: string, subject: string | null) {
  return {
    provider,
    provider_account_id: accountId,
    client_id: 'client',
    display_name: accountId,
    subject,
    encrypted_access_token: 'sealed',
    encrypted_refresh_token: 'sealed',
    expires_at: new Date('2026-01-01T00:00:00Z'),
  };
}

/** A memory store holding these grants. */
async function storeWith(rows: ReturnType<typeof grant>[]) {
  const store = createMemoryDataStore();
  await store.seed({ provider_grants: rows });
  registerDataStore(store);
  return store;
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/audit${query}`);
}

function session(subject: string, roles: string[]) {
  return {
    id: 'session-1',
    subject,
    roles,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe('GET /api/audit', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });
  afterEach(() => resetDataStore());

  it('rejects a caller with no session', async () => {
    mockGetSession.mockResolvedValue(null);
    await storeWith([grant('atlassian', 'acc-a', 'user-a@example.com')]);

    const response = await GET(request('?accountId=acc-a'));

    expect(response.status).toBe(401);
  });

  it('ignores an x-operator-key header, which is no longer an auth mechanism', async () => {
    mockGetSession.mockResolvedValue(null);
    await storeWith([]);

    const headed = new NextRequest(`http://localhost/api/audit`, {
      headers: { 'x-operator-key': 'anything' },
    });
    const response = await GET(headed);

    expect(response.status).toBe(401);
  });

  it('gives an operator the organization-wide log context', async () => {
    mockGetSession.mockResolvedValue(session('op@example.com', ['renkei-operator']));
    await storeWith([]);

    const body = await (await GET(request())).json();

    expect(body.role).toBe('renkei-operator');
    expect(body.logContext).toBe('mcp');
  });

  it("derives a user's account id from their session, not the query string", async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    await storeWith([
      grant('atlassian', 'acc-other', 'user-b@example.com'),
      grant('zoom', 'acc-zoom', 'user-a@example.com'),
      grant('atlassian', 'acc-a', 'user-a@example.com'),
    ]);

    const body = await (await GET(request())).json();

    expect(body.accountId).toBe('acc-a');
    expect(body.logContext).toBe('mcp:acc-a');
  });

  it('refuses a user asking for another account', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    await storeWith([grant('atlassian', 'acc-a', 'user-a@example.com')]);

    const response = await GET(request('?accountId=acc-b'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Cannot view other users audit logs',
    });
  });

  it('allows a user naming their own account', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com', ['renkei-user']));
    await storeWith([grant('atlassian', 'acc-a', 'user-a@example.com')]);

    const response = await GET(request('?accountId=acc-a'));

    expect(response.status).toBe(200);
  });

  it('refuses a user with no grant', async () => {
    mockGetSession.mockResolvedValue(session('user-c@example.com', ['renkei-user']));
    await storeWith([]);

    const response = await GET(request());

    expect(response.status).toBe(403);
  });

  it('refuses a session carrying no recognised role', async () => {
    mockGetSession.mockResolvedValue(session('nobody@example.com', []));
    await storeWith([grant('atlassian', 'acc-a', 'user-a@example.com')]);

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid user role' });
  });
});
