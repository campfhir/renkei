/**
 * Tests for the identity provider configuration.
 *
 * This record decides who becomes an operator, so an unauthorised write to it
 * is full takeover: point the deployment at an attacker-controlled IdP,
 * nominate the claim value that confers renkei-operator, sign in. The rule
 * these tests pin is that the first configuration needs the one-time setup
 * secret — operator identity comes from OIDC, so no operator can exist before
 * a provider is configured — while every change after that requires an
 * operator session.
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
// Access is role-based: checkAccess reads the session, whose real
// implementation reads cookies() — which has no request scope in a test.
jest.mock('@/lib/session', () => ({ getSessionFromCookies: jest.fn(async () => null) }));
jest.mock('@/lib/tenant-operations', () => ({
  setTenantOidc: jest.fn(),
  createTenantOidcIfAbsent: jest.fn(),
}));
jest.mock('@/lib/setup-secret', () => ({
  SETUP_SECRET_HEADER: 'x-renkei-setup-secret',
  identityProviderConfigured: jest.fn(),
  verifySetupSecret: jest.fn(),
  clearSetupSecret: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromCookies: mockGetSession } = jest.requireMock<{
  getSessionFromCookies: jest.Mock;
}>('@/lib/session');
const { setTenantOidc: mockSetTenantOidc, createTenantOidcIfAbsent: mockCreateTenantOidc } =
  jest.requireMock<{ setTenantOidc: jest.Mock; createTenantOidcIfAbsent: jest.Mock }>(
    '@/lib/tenant-operations'
  );
const {
  identityProviderConfigured: mockConfigured,
  verifySetupSecret: mockVerify,
  clearSetupSecret: mockClear,
} = jest.requireMock<{
  identityProviderConfigured: jest.Mock;
  verifySetupSecret: jest.Mock;
  clearSetupSecret: jest.Mock;
}>('@/lib/setup-secret');

const SECRET = 'the-setup-secret';

/** The route's one read of its own: the OIDC row GET returns. */
function stubDb(options: { existingOidc?: boolean } = {}) {
  const { existingOidc = false } = options;
  const db = {
    selectFrom() {
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => (existingOidc ? { client_id: 'existing-client' } : undefined),
      };
      return chain;
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  mockConfigured.mockResolvedValue(existingOidc);
}

/** The setup secret as the verifier sees it: live and matching unless told otherwise. */
function stubSecret(verdict: 'ok' | 'missing' | 'expired' | 'mismatch' | 'none-issued' = 'ok') {
  mockVerify.mockImplementation(async (_db: unknown, presented: string | null) =>
    verdict === 'ok' ? (presented === SECRET ? 'ok' : presented ? 'mismatch' : 'missing') : verdict
  );
}

function post(body: unknown, options: { setupSecret?: string | null } = {}): NextRequest {
  const { setupSecret = SECRET } = options;
  return new NextRequest('http://localhost/api/oidc', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(setupSecret ? { 'x-renkei-setup-secret': setupSecret } : {}),
    },
    body: JSON.stringify(body),
  });
}

function grantOperator() {
  mockGetSession.mockResolvedValue({
    id: 's1',
    subject: 'op@example.com',
    roles: ['renkei-operator'],
    expiresAt: new Date(Date.now() + 60_000),
  });
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

describe('OIDC configuration', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
    mockSetTenantOidc.mockReset();
    mockCreateTenantOidc.mockReset();
    mockConfigured.mockReset();
    mockVerify.mockReset();
    mockClear.mockReset();
    mockSetTenantOidc.mockResolvedValue({ ok: true, val: undefined });
    mockCreateTenantOidc.mockResolvedValue({ ok: true, val: true });
    mockClear.mockResolvedValue(undefined);
    stubSecret();
    stubDiscovery();
  });

  describe('POST before any provider is configured', () => {
    it('allows an unauthenticated caller holding the setup secret', async () => {
      stubDb({ existingOidc: false });

      const response = await POST(post(VALID_BODY));

      expect(response.status).toBe(200);
      expect(mockCreateTenantOidc).toHaveBeenCalledTimes(1);
      // Never the upserting writer on this path.
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
      // The secret was for exactly this write: spent.
      expect(mockClear).toHaveBeenCalledTimes(1);
    });

    it('refuses a caller with no setup secret before fetching discovery', async () => {
      // The squat: whoever reaches the deployment first posting their own
      // IdP. Without the secret only the server log holds, reaching it buys
      // nothing.
      stubDb({ existingOidc: false });

      const response = await POST(post(VALID_BODY, { setupSecret: null }));

      expect(response.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses a wrong setup secret', async () => {
      stubDb({ existingOidc: false });

      const response = await POST(post(VALID_BODY, { setupSecret: 'guess' }));

      expect(response.status).toBe(401);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses an expired setup secret even when it matches', async () => {
      stubDb({ existingOidc: false });
      stubSecret('expired');

      const response = await POST(post(VALID_BODY));

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('expired') });
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses when no secret was ever issued (the setup page was never opened)', async () => {
      stubDb({ existingOidc: false });
      stubSecret('none-issued');

      const response = await POST(post(VALID_BODY));

      expect(response.status).toBe(401);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('does not overwrite a configuration that appeared mid-request', async () => {
      // The insert is conditional in the database, so a caller that lost the
      // race is told to authenticate rather than silently replacing the winner.
      stubDb({ existingOidc: false });
      mockCreateTenantOidc.mockResolvedValue({ ok: true, val: false });

      const response = await POST(post(VALID_BODY));

      expect(response.status).toBe(409);
      expect(mockClear).not.toHaveBeenCalled();
    });

    it('still rejects a body missing required fields', async () => {
      stubDb({ existingOidc: false });

      const response = await POST(post({ clientId: 'only-this' }));

      expect(response.status).toBe(400);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses an SSRF discovery endpoint (metadata IP) without fetching it', async () => {
      // The first-run path must not be usable to reach cloud metadata or
      // internal hosts.
      stubDb({ existingOidc: false });

      const response = await POST(
        post({ ...VALID_BODY, discoveryEndpoint: 'https://169.254.169.254/latest/meta-data/' })
      );

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('refuses a non-https discovery endpoint', async () => {
      stubDb({ existingOidc: false });

      const response = await POST(
        post({ ...VALID_BODY, discoveryEndpoint: 'http://idp.example.com/.well-known/x' })
      );

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses when the discovery document names an internal issuer', async () => {
      // A public discovery URL must not be able to smuggle an internal issuer
      // (which login/callback would later fetch) past the guard.
      stubDb({ existingOidc: false });
      stubDiscovery('https://localhost/');

      const response = await POST(post(VALID_BODY));

      expect(response.status).toBe(400);
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });
  });

  describe('POST once a provider is configured', () => {
    it('rejects an unauthenticated caller, setup secret or not', async () => {
      stubDb({ existingOidc: true });

      const response = await POST(post(VALID_BODY));

      expect(response.status).toBe(401);
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
      expect(mockCreateTenantOidc).not.toHaveBeenCalled();
    });

    it('rejects a signed-in caller without the operator role', async () => {
      stubDb({ existingOidc: true });
      mockGetSession.mockResolvedValue({
        id: 's2',
        subject: 'someone@example.com',
        roles: ['renkei-user'],
        expiresAt: new Date(Date.now() + 60_000),
      });

      const response = await POST(post(VALID_BODY, { setupSecret: null }));

      expect(response.status).toBe(401);
      expect(mockSetTenantOidc).not.toHaveBeenCalled();
    });

    it('allows an operator', async () => {
      stubDb({ existingOidc: true });
      grantOperator();

      const response = await POST(post(VALID_BODY, { setupSecret: null }));

      expect(response.status).toBe(200);
      expect(mockSetTenantOidc).toHaveBeenCalledTimes(1);
    });

    it('refuses before fetching the attacker-supplied discovery endpoint', async () => {
      // The gate runs first, so an unauthenticated caller cannot use this route
      // to make the server issue outbound requests.
      stubDb({ existingOidc: true });

      await POST(post(VALID_BODY));

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('rejects an unauthenticated caller before reading anything', async () => {
      stubDb({ existingOidc: true });

      const response = await GET();

      expect(response.status).toBe(401);
      expect(mockGetDatabase).not.toHaveBeenCalled();
    });

    it('rejects a signed-in caller without the operator role', async () => {
      stubDb({ existingOidc: true });
      mockGetSession.mockResolvedValue({
        id: 's2',
        subject: 'someone@example.com',
        roles: ['renkei-user'],
        expiresAt: new Date(Date.now() + 60_000),
      });

      const response = await GET();

      expect(response.status).toBe(401);
    });

    it('serves an operator', async () => {
      stubDb({ existingOidc: true });
      grantOperator();

      const response = await GET();

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ configured: true });
    });
  });
});
