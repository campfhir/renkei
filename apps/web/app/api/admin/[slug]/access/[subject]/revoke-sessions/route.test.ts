/**
 * Operator sign-out-everywhere: operator-only, never on oneself, and it
 * removes the person's sessions AND both MCP token tables in this tenant.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/tenant-slug', () => ({ tenantForSlug: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { tenantForSlug: mockTenantForSlug } = jest.requireMock<{ tenantForSlug: jest.Mock }>(
  '@/lib/tenant-slug'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const TARGET = 'bob@example.com';

function stubDb() {
  const deletes: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const trx = {
    deleteFrom(table: string) {
      const filters: Array<[string, unknown]> = [];
      const entry = { table, filters };
      deletes.push(entry);
      const chain = {
        where(column: string, _op: string, value: unknown) {
          entry.filters.push([column, value]);
          return chain;
        },
        executeTakeFirst: async () => ({ numDeletedRows: BigInt(2) }),
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: { transaction: () => ({ execute: (fn: (t: typeof trx) => unknown) => fn(trx) }) },
  });
  return { deletes };
}

function request(subject = TARGET) {
  return {
    request: new NextRequest(
      `http://localhost/api/admin/acme/access/${encodeURIComponent(subject)}/revoke-sessions`,
      { method: 'POST' }
    ),
    context: { params: Promise.resolve({ slug: 'acme', subject: encodeURIComponent(subject) }) },
  };
}

describe('POST /api/admin/{slug}/access/{subject}/revoke-sessions', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockCheckAccess.mockReset();
    mockTenantForSlug.mockReset().mockResolvedValue({ id: TENANT, slug: 'acme' });
    mockAudit.mockReset();
  });

  it('refuses a caller who is not an operator before touching the database', async () => {
    mockCheckAccess.mockResolvedValue(null);
    const { request: req, context } = request();
    const response = await POST(req, context);
    expect(response.status).toBe(401);
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it("deletes the person's sessions, access tokens and refresh tokens in this tenant, and audits it", async () => {
    mockCheckAccess.mockResolvedValue({ subject: 'op@example.com', roles: ['renkei-operator'] });
    const { deletes } = stubDb();
    const { request: req, context } = request();

    const response = await POST(req, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      revoked: { sessions: 2, accessTokens: 2, refreshTokens: 2 },
    });
    expect(deletes.map((d) => d.table).sort()).toEqual([
      'oauth_access_tokens',
      'oauth_refresh_tokens',
      'sessions',
    ]);
    for (const del of deletes) {
      expect(del.filters).toEqual([
        [TENANT],
        ['subject', TARGET],
      ]);
    }
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'op@example.com',
        action: 'user.sessions_revoked',
        targetLabel: TARGET,
      })
    );
  });

  it('will not sign the operator themselves out from here', async () => {
    mockCheckAccess.mockResolvedValue({ subject: TARGET, roles: ['renkei-operator'] });
    stubDb();
    const { request: req, context } = request(TARGET);
    const response = await POST(req, context);
    expect(response.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
