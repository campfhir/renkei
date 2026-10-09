/**
 * Operator revoke of a connector grant also ends the grant owner's MCP
 * bearer credentials: an access or refresh token issued to them would
 * otherwise keep naming them as the caller until it expired.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/tenant-slug', () => ({ tenantForSlug: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { tenantForSlug: mockTenantForSlug } = jest.requireMock<{ tenantForSlug: jest.Mock }>(
  '@/lib/tenant-slug'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

function stubDb(grant: Record<string, unknown> | undefined) {
  const deletes: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const db = {
    selectFrom() {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => grant,
      };
      return chain;
    },
    deleteFrom(table: string) {
      const filters: Array<[string, unknown]> = [];
      const entry = { table, filters };
      deletes.push(entry);
      const chain = {
        where(column: string, _op: string, value: unknown) {
          entry.filters.push([column, value]);
          return chain;
        },
        execute: async () => undefined,
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { deletes };
}

function revoke() {
  return POST(
    new NextRequest('http://localhost/api/admin/acme/grants/acct-1/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'microsoft' }),
    }),
    { params: Promise.resolve({ slug: 'acme', grantId: 'acct-1' }) }
  );
}

describe('POST /api/admin/{slug}/grants/{grantId}/revoke', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockTenantForSlug.mockReset().mockResolvedValue({ id: TENANT, slug: 'acme' });
    mockCheckAccess
      .mockReset()
      .mockResolvedValue({ subject: 'op@example.com', roles: ['renkei-operator'] });
  });

  it("deletes the grant and the owner's MCP access and refresh tokens for the tenant", async () => {
    const { deletes } = stubDb({
      provider_account_id: 'acct-1',
      display_name: 'Bob',
      subject: 'bob@example.com',
    });

    const response = await revoke();

    expect(response.status).toBe(200);
    expect(deletes.map((d) => d.table)).toEqual([
      'provider_grants',
      'oauth_access_tokens',
      'oauth_refresh_tokens',
    ]);
    for (const del of deletes.slice(1)) {
      expect(del.filters).toEqual([
        ['tenant_id', TENANT],
        ['subject', 'bob@example.com'],
      ]);
    }
  });

  it('leaves tokens alone for a legacy grant with no owning subject', async () => {
    const { deletes } = stubDb({
      provider_account_id: 'acct-1',
      display_name: 'Old',
      subject: null,
    });
    const response = await revoke();
    expect(response.status).toBe(200);
    expect(deletes.map((d) => d.table)).toEqual(['provider_grants']);
  });
});
