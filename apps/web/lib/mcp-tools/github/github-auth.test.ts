/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The wire boundary: what oauthGitHubAuth actually SENDS. The tool
 * suite stubs auth.fetch, so nothing there would catch the one failure
 * that matters most in the field — a request leaving without its
 * Authorization header. This suite mocks nothing below global.fetch:
 * grant row → decrypted token → the exact header bytes.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

const grantRow: { provider_account_id: string } | undefined = { provider_account_id: '12345' };
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

let storedAccessToken = 'gho_live-token-123';
jest.mock('@renkei/provider-grants', () => ({
  GITHUB: 'github',
  GitHubAdapter: class {},
  readGitHubMetadata: () => ({ login: 'octocat' }),
  getGrant: async () => ({
    ok: true,
    val: {
      accountId: '12345',
      clientId: 'client-id',
      accessToken: storedAccessToken,
      refreshToken: 'refresh-1',
      // Far future: the refresh path stays out of this suite's way.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      metadata: { login: 'octocat' },
    },
  }),
  refreshGrantTokens: jest.fn(),
}));

jest.mock('@/lib/github-app', () => ({
  getGitHubApp: async () => null,
}));

import { oauthGitHubAuth } from './github-auth';
import type { MCPToolContext } from '../common';

const fetchSpy = jest.fn();

const context = {
  tenantId: 'tenant-1',
  subject: 'subject-1',
  origin: 'https://renkei.example',
} as unknown as MCPToolContext;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
  global.fetch = fetchSpy as unknown as typeof fetch;
  storedAccessToken = 'gho_live-token-123';
});

describe('what actually leaves the process', () => {
  it('sends the decrypted token as a capital-B Bearer header', async () => {
    const auth = oauthGitHubAuth(context);
    const response = await auth.fetch(['repository'], '/user/installations?per_page=100');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/user/installations?per_page=100');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer gho_live-token-123'
    );
  });

  it('refuses to send at all when the stored token is empty', async () => {
    storedAccessToken = '';
    const auth = oauthGitHubAuth(context);
    const response = await auth.fetch(['repository'], '/user/installations?per_page=100');

    // Refused locally with the reconnect pointer — never "Bearer " on the wire.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('no access token');
  });

  it('a capability the connection lacks is refused before any network call', async () => {
    const auth = oauthGitHubAuth({
      ...context,
      githubScopes: ['repository'],
    } as unknown as MCPToolContext);
    const response = await auth.fetch(['pullrequest:write'], '/x');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });
});
