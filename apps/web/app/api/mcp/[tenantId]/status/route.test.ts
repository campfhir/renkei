/**
 * Tests for the Jira connection probe.
 *
 * Both guards here are load-bearing. Without the session check the endpoint
 * discloses a tenant's Atlassian account id, the holder's real name and their
 * Jira site to anyone who knows the tenantId, which is not a secret. Without
 * the subject filter it reports one user's grant to another, so the page tells
 * someone with no grant that they are connected.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET } from './route';

// Fetched through requireMock rather than the typed import: these stubs stand
// in for a Kysely instance, which cannot be satisfied structurally, and the
// codebase bans type assertions.
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const TENANT = '00000000-0000-4000-8000-000000000001';

interface Recorded {
  table: string;
  columns: string[];
  filters: Array<[string, string, unknown]>;
}

/**
 * Minimal stand-in for the Kysely chain this route uses, which also records
 * the query so the subject filter can be asserted rather than assumed.
 */
function stubDb(row: Record<string, unknown> | undefined) {
  const recorded: Recorded = { table: '', columns: [], filters: [] };
  const chain = {
    select(columns: string[]) {
      recorded.columns = columns;
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
  const db = {
    selectFrom(table: string) {
      recorded.table = table;
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return recorded;
}

/** The route reads nothing off the request; the session lookup is mocked. */
function request(): NextRequest {
  return new NextRequest('http://localhost/api/mcp/status');
}

function params(tenantId = TENANT) {
  return { params: Promise.resolve({ tenantId }) };
}

function session(subject: string) {
  return {
    id: 'session-1',
    tenantId: TENANT,
    subject,
    roles: ['renkei-user'],
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe('GET /api/mcp/{tenantId}/status', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
  });

  it('rejects a caller with no session', async () => {
    mockGetSession.mockResolvedValue(null);
    const recorded = stubDb(undefined);

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    // Nothing about the tenant is disclosed, not even whether it exists.
    expect(recorded.table).toBe('');
  });

  it('does not touch the database before authenticating', async () => {
    mockGetSession.mockResolvedValue(null);
    stubDb(undefined);

    await GET(request(), params());

    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller, the tenant and the provider', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    const recorded = stubDb({
      provider_account_id: 'acc-a',
      display_name: 'User A',
      metadata: { siteUrl: 'https://example.atlassian.net' },
    });

    await GET(request(), params());

    expect(recorded.table).toBe('provider_grants');
    expect(recorded.filters).toEqual([
      ['tenant_id', '=', TENANT],
      ['provider', '=', 'atlassian'],
      ['subject', '=', 'user-a@example.com'],
    ]);
  });

  it('reports the caller as connected when they hold the grant', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    stubDb({
      provider_account_id: 'acc-a',
      display_name: 'User A',
      metadata: { siteUrl: 'https://example.atlassian.net' },
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      accountId: 'acc-a',
      displayName: 'User A',
      siteUrl: 'https://example.atlassian.net',
    });
  });

  it('reports not connected when only another user in the tenant has a grant', async () => {
    // The subject filter means the query returns nothing for user B even though
    // user A's grant exists on the same tenant.
    mockGetSession.mockResolvedValue(session('user-b@example.com'));
    stubDb(undefined);

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connected).toBe(false);
    // No trace of the other user.
    expect(JSON.stringify(body)).not.toMatch(/acc-a|User A/);
  });

  it('never returns encrypted token material', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    const recorded = stubDb({
      provider_account_id: 'acc-a',
      display_name: 'User A',
      metadata: { siteUrl: 'https://example.atlassian.net', cloudId: 'cloud-1' },
    });

    const body = await (await GET(request(), params())).json();

    expect(recorded.columns).not.toContain('encrypted_access_token');
    expect(recorded.columns).not.toContain('encrypted_refresh_token');
    expect(Object.keys(body).sort()).toEqual(['accountId', 'connected', 'displayName', 'siteUrl']);
  });

  it('tolerates a grant whose metadata carries no site url', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    stubDb({ provider_account_id: 'acc-a', display_name: 'User A', metadata: {} });

    const body = await (await GET(request(), params())).json();

    expect(body).toEqual({
      connected: true,
      accountId: 'acc-a',
      displayName: 'User A',
      siteUrl: null,
    });
  });
});
