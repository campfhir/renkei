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
// safeFetch goes through the sandbox package's guarded fetch, which dials
// node:https at a resolved address; here the structural guard stays real,
// every name resolves publicly, and the request itself is the global.fetch
// stub the tests script and assert on.
jest.mock('@renkei/connector-sandbox', () => {
  const actual = jest.requireActual<typeof import('@renkei/connector-sandbox')>(
    '@renkei/connector-sandbox'
  );
  return {
    ...actual,
    resolvePublicAddress: async (hostname: string) => {
      actual.assertSafeHostname(hostname);
      return '93.184.216.34';
    },
    guardedFetch: (url: string, init?: RequestInit) => {
      actual.assertSafeHttpsUrl(url);
      return global.fetch(url, init);
    },
  };
});
// Access is role-based: checkAccess reads the tenant session, whose real
// implementation reads cookies() — which has no request scope in a test.
jest.mock('@/lib/session', () => ({ getSessionFromCookies: jest.fn(async () => null) }));
jest.mock('@/lib/tenant-operations', () => ({
  setTenantOidc: jest.fn(),
  createTenantOidcIfAbsent: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { mintBootstrapSecret } from '@/lib/tenant-bootstrap';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromCookies: mockGetSession } = jest.requireMock<{
  getSessionFromCookies: jest.Mock;
}>('@/lib/session');
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
/** A live onboarding secret, as api/home-realm/create would have minted it. */
const BOOTSTRAP = mintBootstrapSecret();

function stubDb(
  options: {
    tenantExists?: boolean;
    existingOidc?: boolean;
    /** The tenants row's bootstrap columns; defaults to BOOTSTRAP, live. */
    bootstrap?: { bootstrap_secret_hash: string | null; bootstrap_secret_expires_at: Date | null };
  } = {}
) {
  const {
    tenantExists = true,
    existingOidc = false,
    bootstrap = {
      bootstrap_secret_hash: BOOTSTRAP.hash,
      bootstrap_secret_expires_at: BOOTSTRAP.expiresAt,
    },
  } = options;
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const db = {
    selectFrom(table: string) {
      const row =
        table === 'tenants'
          ? tenantExists
            ? { id: TENANT, ...bootstrap }
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
    updateTable(table: string) {
      const chain = {
        set(values: Record<string, unknown>) {
          updates.push({ table, values });
          return chain;
        },
        where: () => chain,
        execute: async () => undefined,
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { updates };
}

function post(
  body: unknown,
  tenantId = TENANT,
  options: { bootstrapSecret?: string | null } = {}
): NextRequest {
  const { bootstrapSecret = BOOTSTRAP.secret } = options;
  return new NextRequest(`http://localhost/api/tenant/${tenantId}/oidc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bootstrapSecret ? { 'x-renkei-bootstrap-secret': bootstrapSecret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function params(tenantId = TENANT) {
  return { params: Promise.resolve({ tenantId }) };
}

/**
 * Grant the operator role for one tenant. The session cookie is per-tenant,
 * so asked about any other tenant the mock answers "no session" — which is
 * exactly how a cross-tenant caller presents in production.
 */
function grantOperatorFor(tenantId: string) {
  mockGetSession.mockImplementation(async (tid: string) =>
    tid === tenantId
      ? {
          id: 's1',
          tenantId: tid,
          subject: 'op@example.com',
          roles: ['renkei-operator'],
          expiresAt: new Date(Date.now() + 60_000),
        }
      : null
  );
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
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
    mockSetTenantOidc.mockReset();
    mockCreateTenantOidc.mockReset();
    mockSetTenantOidc.mockResolvedValue({ ok: true, val: undefined });
    mockCreateTenantOidc.mockResolvedValue({ ok: true, val: true });
    stubDiscovery();
  });

  describe('POST on an unconfigured tenant', () => {
    it('allows an unauthenticated caller holding the onboarding secret to bootstrap', async () => {
      const { updates } = stubDb({ existingOidc: false });
      mockGetSession.mockResolvedValue(null);

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(200);
      expect(mockCreateTenantOidc).toHaveBeenCalledTimes(1);
      // Never the upserting writer on this path.
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
      // The secret was for exactly this write: spent.
      expect(updates).toEqual([
        {
          table: 'tenants',
          values: { bootstrap_secret_hash: null, bootstrap_secret_expires_at: null },
        },
      ]);
    });

    it('refuses a caller with no onboarding secret before fetching discovery', async () => {
      // The squat: anyone who learned the tenant id posting their own IdP
      // first. Without the secret only the creator saw, the id buys nothing.
      stubDb({ existingOidc: false });

      const response = await POST(post(VALID_BODY, TENANT, { bootstrapSecret: null }), params());

      expect(response.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses a wrong onboarding secret', async () => {
      stubDb({ existingOidc: false });

      const response = await POST(
        post(VALID_BODY, TENANT, { bootstrapSecret: 'a-guess' }),
        params()
      );

      expect(response.status).toBe(401);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses an expired onboarding secret even when it matches', async () => {
      const stale = mintBootstrapSecret(new Date(Date.now() - 48 * 60 * 60 * 1000));
      stubDb({
        existingOidc: false,
        bootstrap: {
          bootstrap_secret_hash: stale.hash,
          bootstrap_secret_expires_at: stale.expiresAt,
        },
      });

      const response = await POST(
        post(VALID_BODY, TENANT, { bootstrapSecret: stale.secret }),
        params()
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('expired') });
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses to bootstrap a tenant that never had a secret (pre-migration or spent)', async () => {
      stubDb({
        existingOidc: false,
        bootstrap: { bootstrap_secret_hash: null, bootstrap_secret_expires_at: null },
      });

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(401);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('does not overwrite a configuration that appeared mid-request', async () => {
      // The insert is conditional in the database, so a caller that lost the
      // race is told to authenticate rather than silently replacing the winner.
      stubDb({ existingOidc: false });
      mockGetSession.mockResolvedValue(null);
      mockCreateTenantOidc.mockResolvedValue({ ok: true, val: false });

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(409);
    });

    it('still rejects a body missing required fields', async () => {
      stubDb({ existingOidc: false });
      mockGetSession.mockResolvedValue(null);

      const response = await POST(post({ clientId: 'only-this' }), params());

      expect(response.status).toBe(400);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses an SSRF discovery endpoint (metadata IP) without fetching it', async () => {
      // The unauthenticated bootstrap path must not be usable to reach cloud
      // metadata or internal hosts.
      stubDb({ existingOidc: false });
      mockGetSession.mockResolvedValue(null);

      const response = await POST(
        post({
          ...VALID_BODY,
          discoveryEndpoint: 'https://169.254.169.254/latest/meta-data/',
        }),
        params()
      );

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses a non-https discovery endpoint', async () => {
      stubDb({ existingOidc: false });
      mockGetSession.mockResolvedValue(null);

      const response = await POST(
        post({ ...VALID_BODY, discoveryEndpoint: 'http://idp.example.com/.well-known/x' }),
        params()
      );

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses when the discovery document names an internal issuer', async () => {
      // A public discovery URL must not be able to smuggle an internal issuer
      // (which login/callback would later fetch) past the guard.
      stubDb({ existingOidc: false });
      mockGetSession.mockResolvedValue(null);
      stubDiscovery('https://localhost/');

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(400);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });
  });

  describe('POST on a configured tenant', () => {
    it('rejects an unauthenticated caller', async () => {
      stubDb({ existingOidc: true });
      mockGetSession.mockResolvedValue(null);

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(401);
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('rejects an operator of a different tenant', async () => {
      stubDb({ existingOidc: true });
      grantOperatorFor(OTHER_TENANT);

      const response = await POST(post(VALID_BODY), params());

      // 401 rather than 403: a wrong-tenant credential is simply not a
      // credential for this tenant, so the gate reports "not authenticated"
      // instead of leaking that the caller holds one elsewhere.
      expect(response.status).toBe(401);
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
    });

    it('allows an operator of this tenant', async () => {
      stubDb({ existingOidc: true });
      grantOperatorFor(TENANT);

      const response = await POST(post(VALID_BODY), params());

      expect(response.status).toBe(200);
      expect(mockSetTenantOidc).toHaveBeenCalledTimes(1);
    });

    it('refuses before fetching the attacker-supplied discovery endpoint', async () => {
      // The gate runs first, so an unauthenticated caller cannot use this route
      // to make the server issue outbound requests.
      stubDb({ existingOidc: true });
      mockGetSession.mockResolvedValue(null);

      await POST(post(VALID_BODY), params());

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('rejects an unauthenticated caller before reading anything', async () => {
      stubDb({ existingOidc: true });
      mockGetSession.mockResolvedValue(null);

      const response = await GET(post({}), params());

      expect(response.status).toBe(401);
      expect(mockGetDatabase).not.toHaveBeenCalled();
    });

    it('rejects an operator of a different tenant', async () => {
      stubDb({ existingOidc: true });
      grantOperatorFor(OTHER_TENANT);

      const response = await GET(post({}), params());

      expect(response.status).toBe(401);
    });

    it('serves an operator of this tenant', async () => {
      stubDb({ existingOidc: true });
      grantOperatorFor(TENANT);

      const response = await GET(post({}), params());

      expect(response.status).toBe(200);
    });
  });
});
