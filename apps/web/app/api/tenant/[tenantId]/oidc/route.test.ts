/**
 * Tests for tenant identity provider configuration.
 *
 * This record decides who becomes an operator of a tenant, so an unauthorised
 * write to it is full takeover: point the tenant at an attacker-controlled IdP,
 * nominate the claim value that confers renkei-operator, sign in. The rule
 * these tests pin is that creation is open — operator identity comes from OIDC,
 * so no operator can exist before one is configured — while every change after
 * that requires an operator of this same tenant.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/auth-utils', () => ({ getOperatorSession: jest.fn() }));
jest.mock('@/lib/tenant-operations', () => ({
  setTenantOidc: jest.fn(),
  createTenantOidcIfAbsent: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getOperatorSession: mockGetOperatorSession } = jest.requireMock<{
  getOperatorSession: jest.Mock;
}>('@/lib/auth-utils');
const { setTenantOidc: mockSetTenantOidc, createTenantOidcIfAbsent: mockCreateTenantOidc } =
  jest.requireMock<{ setTenantOidc: jest.Mock; createTenantOidcIfAbsent: jest.Mock }>(
    '@/lib/tenant-operations'
  );

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000ff';

/**
 * Stubs the two reads this route makes: the tenant row, then the existing OIDC
 * row. `existingOidc` undefined means the tenant is unconfigured.
 */
function stubDb(options: { tenantExists?: boolean; existingOidc?: boolean } = {}) {
  const { tenantExists = true, existingOidc = false } = options;
  const db = {
    selectFrom(table: string) {
      const row =
        table === 'tenants'
          ? tenantExists
            ? { id: TENANT }
            : undefined
          : existingOidc
            ? { client_id: 'existing-client' }
            : undefined;
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => row,
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
}

function post(body: unknown, tenantId = TENANT): NextRequest {
  return new NextRequest(`http://localhost/api/tenant/${tenantId}/oidc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(tenantId = TENANT) {
  return { params: Promise.resolve({ tenantId }) };
}

function operatorSession(tenantId: string) {
  return {
    sessionId: 's1',
    subject: 'op@example.com',
    operator: 'Operator',
    tenantId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

const VALID_BODY = {
  discoveryEndpoint: 'https://idp.example.com/.well-known/openid-configuration',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  operatorIdpValue: 'admins',
};

/** The route fetches the discovery document to learn the issuer. */
function stubDiscovery(issuer: string | null = 'https://idp.example.com') {
  global.fetch = jest.fn().mockResolvedValue(
    new Response(JSON.stringify(issuer ? { issuer } : {}), {
      headers: { 'content-type': 'application/json' },
    })
  );
}

describe('tenant OIDC configuration', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetOperatorSession.mockReset();
    mockSetTenantOidc.mockReset();
    mockCreateTenantOidc.mockReset();
    mockSetTenantOidc.mockResolvedValue({ ok: true, val: undefined });
    mockCreateTenantOidc.mockResolvedValue({ ok: true, val: true });
    stubDiscovery();
  });

  describe('POST on an unconfigured tenant', () => {
    it('allows an unauthenticated caller to bootstrap', async () => {
      stubDb({ existingOidc: false });
      mockGetOperatorSession.mockResolvedValue(null);

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(200);
      expect(mockCreateTenantOidc).toHaveBeenCalledTimes(1);
      // Never the upserting writer on this path.
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
    });

    it('does not overwrite a configuration that appeared mid-request', async () => {
      // The insert is conditional in the database, so a caller that lost the
      // race is told to authenticate rather than silently replacing the winner.
      stubDb({ existingOidc: false });
      mockGetOperatorSession.mockResolvedValue(null);
      mockCreateTenantOidc.mockResolvedValue({ ok: true, val: false });

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(409);
    });

    it('still rejects a body missing required fields', async () => {
      stubDb({ existingOidc: false });
      mockGetOperatorSession.mockResolvedValue(null);

      const response = await POST(post({ clientId: 'only-this' }), params());

      expect(response.status).toBe(400);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });
  });

  describe('POST on a configured tenant', () => {
    it('rejects an unauthenticated caller', async () => {
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(null);

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(401);
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('rejects an operator of a different tenant', async () => {
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(operatorSession(OTHER_TENANT));

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(403);
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
    });

    it('allows an operator of this tenant', async () => {
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(operatorSession(TENANT));

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(200);
      expect(mockSetTenantOidc).toHaveBeenCalledTimes(1);
    });

    it('refuses before fetching the attacker-supplied discovery endpoint', async () => {
      // The gate runs first, so an unauthenticated caller cannot use this route
      // to make the server issue outbound requests.
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(null);

      await POST(post(VALID_BODY), params());

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('rejects an unauthenticated caller before reading anything', async () => {
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(null);

      const response = await GET(post({}), params());

      expect(response.status).toBe(401);
      expect(mockGetDatabase).not.toHaveBeenCalled();
    });

    it('rejects an operator of a different tenant', async () => {
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(operatorSession(OTHER_TENANT));

      const response = await GET(post({}), params());

      expect(response.status).toBe(403);
    });

    it('serves an operator of this tenant', async () => {
      stubDb({ existingOidc: true });
      mockGetOperatorSession.mockResolvedValue(operatorSession(TENANT));

      const response = await GET(post({}), params());

      expect(response.status).toBe(200);
    });
  });
});
