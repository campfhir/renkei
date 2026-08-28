/**
 * The wire boundary: what oauthBitbucketAuth actually SENDS. The tool
 * suite stubs auth.fetch, so nothing there would catch the one failure
 * that matters most in the field — a request leaving without its
 * Authorization header, which Bitbucket answers with an anonymous 404
 * that reads like a wrong URL. This suite mocks nothing below
 * global.fetch: grant row → decrypted token → the exact header bytes.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

const grantRow: { provider_account_id: string } | undefined = { provider_account_id: '{u-1}' };
jest.mock('@renkei/db', () => ({
  getDatabase: () => ({
    ok: true,
    val: {
      selectFrom: () => {
        const chain = {
          select: () => chain,
          where: () => chain,
          orderBy: () => chain,
          executeTakeFirst: async () => grantRow,
        };
        return chain;
      },
    },
  }),
}));

jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: () => ({ ok: true, val: Buffer.alloc(32) }),
}));

let storedAccessToken = 'live-token-123';
jest.mock('@renkei/provider-grants', () => ({
  ATLASSIAN_BITBUCKET: 'atlassian-bitbucket',
  BitbucketAdapter: class {},
  readBitbucketMetadata: () => ({ username: 'scott' }),
  getGrant: async () => ({
    ok: true,
    val: {
      accountId: '{u-1}',
      clientId: 'consumer-key',
      accessToken: storedAccessToken,
      refreshToken: 'refresh-1',
      // Far future: the refresh path stays out of this suite's way.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      metadata: { username: 'scott' },
    },
  }),
  refreshGrantTokens: jest.fn(),
}));

jest.mock('@/lib/atlassian-app', () => ({
  getAtlassianBitbucketApp: async () => null,
}));

import { oauthBitbucketAuth } from './bitbucket-auth';
import type { MCPToolContext } from '../common';

const fetchSpy = jest.fn();

const context = {
  tenantId: 'tenant-1',
  subject: 'subject-1',
  origin: 'https://renkei.example',
} as unknown as MCPToolContext;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify({ values: [] }), { status: 200 }));
  global.fetch = fetchSpy as unknown as typeof fetch;
  storedAccessToken = 'live-token-123';
});

describe('what actually leaves the process', () => {
  it('sends the decrypted token as a capital-B Bearer header', async () => {
    const auth = oauthBitbucketAuth(context);
    const response = await auth.fetch(['account'], '/workspaces?pagelen=50');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.bitbucket.org/2.0/workspaces?pagelen=50');
    // The exact header bytes: Bitbucket treats an empty token or an
    // unrecognized scheme spelling (even lowercase "bearer") as ANONYMOUS
    // and hides real endpoints behind a 404 — so this assertion is on the
    // full value, not just presence.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer live-token-123');
  });

  it('refuses to send at all when the stored token is empty', async () => {
    storedAccessToken = '';
    const auth = oauthBitbucketAuth(context);
    const response = await auth.fetch(['account'], '/workspaces?pagelen=50');

    // Refused locally with the reconnect pointer — never "Bearer " on the
    // wire, which Bitbucket would answer with the misleading anonymous 404.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('no access token');
  });

  it('a scope the connection lacks is refused before any network call', async () => {
    const auth = oauthBitbucketAuth({
      ...context,
      bitbucketScopes: ['repository'],
    } as unknown as MCPToolContext);
    const response = await auth.fetch(['pullrequest:write'], '/x');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
});
