/**
 * Tests for the Jira connection probe.
 *
 * Both guards here are load-bearing. Without the session check the endpoint
 * discloses the organization's Atlassian account id, the holder's real name
 * and their Jira site to anyone who can reach the deployment. Without
 * the subject filter it reports one user's grant to another, so the page tells
 * someone with no grant that they are connected.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET } from './route';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

function grant(
  provider: string,
  account: string,
  subject: string,
  metadata: Record<string, unknown>
) {
  return {
    provider,
    provider_account_id: account,
    client_id: 'client',
    display_name: account === 'acc-a' ? 'User A' : `holder of ${account}`,
    subject,
    encrypted_access_token: 'sealed-access',
    encrypted_refresh_token: 'sealed-refresh',
    expires_at: new Date(Date.now() + 60_000),
    metadata: JSON.stringify(metadata),
  };
}

/** A memory store holding these grants; returns how often grants were listed. */
async function withGrants(rows: ReturnType<typeof grant>[]) {
  const store = createMemoryDataStore();
  await store.seed({ provider_grants: rows });
  const lookups: { subject: string; provider?: string }[] = [];
  registerDataStore({
    ...store,
    providerGrants: {
      ...store.providerGrants,
      listForSubject: (subject, options) => {
        lookups.push({ subject, provider: options?.provider });
        return store.providerGrants.listForSubject(subject, options);
      },
    },
  });
  return lookups;
}

/** The route reads nothing off the request; the session lookup is mocked. */
function request(): NextRequest {
  return new NextRequest('http://localhost/api/mcp/status');
}

function session(subject: string) {
  return {
    id: 'session-1',
    subject,
    roles: ['renkei-user'],
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const siteA = { siteUrl: 'https://example.atlassian.net', cloudId: 'cloud-1' };

describe('GET /api/mcp/status', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });
  afterAll(() => {
    resetDataStore();
  });

  it('rejects a caller with no session, before any lookup', async () => {
    mockGetSession.mockResolvedValue(null);
    const lookups = await withGrants([grant('atlassian', 'acc-a', 'user-a@example.com', siteA)]);

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    // Nothing is disclosed, not even whether a grant exists.
    expect(lookups).toEqual([]);
  });

  it('scopes the lookup to the caller and the provider', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    const lookups = await withGrants([grant('atlassian', 'acc-a', 'user-a@example.com', siteA)]);

    await GET(request());

    expect(lookups).toEqual([{ subject: 'user-a@example.com', provider: 'atlassian' }]);
  });

  it('reports the caller as connected when they hold the grant', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    await withGrants([
      grant('atlassian', 'acc-a', 'user-a@example.com', siteA),
      grant('atlassian-jsm', 'acc-j', 'user-a@example.com', {}),
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      accountId: 'acc-a',
      displayName: 'User A',
      siteUrl: 'https://example.atlassian.net',
    });
  });

  it('reports not connected when only another user has a grant', async () => {
    mockGetSession.mockResolvedValue(session('user-b@example.com'));
    await withGrants([grant('atlassian', 'acc-a', 'user-a@example.com', siteA)]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connected).toBe(false);
    // No trace of the other user.
    expect(JSON.stringify(body)).not.toMatch(/acc-a|User A/);
  });

  it('never returns encrypted token material', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    await withGrants([grant('atlassian', 'acc-a', 'user-a@example.com', siteA)]);

    const body = await (await GET(request())).json();

    expect(JSON.stringify(body)).not.toMatch(/sealed/);
    expect(Object.keys(body).sort()).toEqual(['accountId', 'connected', 'displayName', 'siteUrl']);
  });

  it('tolerates a grant whose metadata carries no site url', async () => {
    mockGetSession.mockResolvedValue(session('user-a@example.com'));
    await withGrants([grant('atlassian', 'acc-a', 'user-a@example.com', {})]);

    const body = await (await GET(request())).json();

    expect(body).toEqual({
      connected: true,
      accountId: 'acc-a',
      displayName: 'User A',
      siteUrl: null,
    });
  });
});
