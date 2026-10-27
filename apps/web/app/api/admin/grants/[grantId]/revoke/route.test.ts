/**
 * Operator revoke of a connector grant also ends the grant owner's MCP
 * bearer credentials: an access or refresh token issued to them would
 * otherwise keep naming them as the caller until it expired.
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { invalidateToolCatalogCache: mockInvalidate } = jest.requireMock<{
  invalidateToolCatalogCache: jest.Mock;
}>('@/lib/mcp-tools/tool-catalog');

const EXPIRES = '2030-01-01T00:00:00.000Z';

/** One microsoft grant (owner `subject`), plus tokens for its owner and for someone else. */
async function seededStore(subject: string | null): Promise<MemoryDataStore> {
  const store = createMemoryDataStore();
  await store.seed({
    provider_grants: [
      {
        provider: 'microsoft',
        provider_account_id: 'acct-1',
        subject,
        display_name: 'Bob',
        client_id: 'client',
        encrypted_access_token: 'a',
        encrypted_refresh_token: 'r',
        expires_at: EXPIRES,
      },
    ],
    oauth_clients: [{ client_id: 'c', client_secret_hash: 'h', redirect_uris: ['https://x'] }],
    oauth_access_tokens: [
      { token_hash: 'a1', client_id: 'c', subject: 'bob@example.com', expires_at: EXPIRES },
      { token_hash: 'a2', client_id: 'c', subject: 'ann@example.com', expires_at: EXPIRES },
    ],
    oauth_refresh_tokens: [
      {
        token_hash: 'r1',
        token_id: '00000000-0000-4000-8000-000000000701',
        client_id: 'c',
        subject: 'bob@example.com',
        expires_at: EXPIRES,
      },
    ],
  });
  registerDataStore(store);
  return store;
}

function revoke(provider = 'microsoft') {
  return POST(
    new NextRequest('http://localhost/api/admin/grants/acct-1/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    }),
    { params: Promise.resolve({ grantId: 'acct-1' }) }
  );
}

const left = (store: MemoryDataStore) => ({
  grants: store.tables.select('provider_grants').length,
  accessTokens: store.tables.select('oauth_access_tokens').map((r) => r.subject),
  refreshTokens: store.tables.select('oauth_refresh_tokens').map((r) => r.subject),
});

describe('POST /api/admin/grants/{grantId}/revoke', () => {
  beforeEach(() => {
    mockInvalidate.mockReset();
    mockCheckAccess
      .mockReset()
      .mockResolvedValue({ subject: 'op@example.com', roles: ['renkei-operator'] });
  });
  afterAll(() => {
    resetDataStore();
  });

  it("deletes the grant and the owner's MCP access and refresh tokens", async () => {
    const store = await seededStore('bob@example.com');

    const response = await revoke();

    expect(response.status).toBe(200);
    expect(left(store)).toEqual({
      grants: 0,
      accessTokens: ['ann@example.com'],
      refreshTokens: [],
    });
    expect(mockInvalidate).toHaveBeenCalledWith('bob@example.com');
  });

  it('leaves tokens alone for a legacy grant with no owning subject', async () => {
    const store = await seededStore(null);
    const response = await revoke();
    expect(response.status).toBe(200);
    expect(left(store)).toEqual({
      grants: 0,
      accessTokens: ['bob@example.com', 'ann@example.com'],
      refreshTokens: ['bob@example.com'],
    });
  });

  it('404s for a grant of another provider, changing nothing', async () => {
    const store = await seededStore('bob@example.com');
    const response = await revoke('zoom');
    expect(response.status).toBe(404);
    expect(left(store).grants).toBe(1);
  });
});
