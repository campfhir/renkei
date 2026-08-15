/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthConfluenceAuth` in isolation.
 *
 * Narrow, like graph-auth.test.ts — see confluence-auth.ts's header for
 * why resolve() is the whole interface. There is no denied/no-sandbox tier
 * here (unlike WebEx/Zoom/Graph): Confluence has a real sandbox, exercised
 * end to end in confluence.integration.test.ts instead.
 */

jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      accountId: 'acct-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { cloudId: 'cloud-1' },
    },
  })),
  refreshGrantTokens: jest.fn(),
  ATLASSIAN_CONFLUENCE: 'atlassian-confluence',
  AtlassianAdapter: class {},
  readAtlassianMetadata: (metadata: unknown) => ({
    cloudId: (metadata as { cloudId?: string })?.cloudId,
  }),
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianConfluenceApp: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

jest.mock('@renkei/db', () => {
  const chain: unknown = new Proxy(
    {},
    {
      get: (_t, property) => {
        if (property === 'executeTakeFirst') {
          return async () => ({ provider_account_id: 'acct-1' });
        }
        return () => chain;
      },
    }
  );
  return { getDatabase: () => ({ ok: true, val: chain }) };
});

import { oauthConfluenceAuth } from './confluence-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
    ...overrides,
  }) as unknown as MCPToolContext;

describe('oauthConfluenceAuth', () => {
  it('resolves a real access token through the mocked grant chain, with a Bearer authHeader', async () => {
    const auth = oauthConfluenceAuth(context());

    const access = await auth.resolve();

    expect(access).toEqual({
      accessToken: 'token-1',
      cloudId: 'cloud-1',
      accountId: 'acct-1',
      authHeader: 'Bearer token-1',
    });
  });

  it('reports an unresolved grant as a string, not a thrown error', async () => {
    const auth = oauthConfluenceAuth(context({ subject: undefined }));

    const access = await auth.resolve();

    expect(typeof access).toBe('string');
    expect(access).toContain('No signed-in subject');
  });

  it('kind is "oauth"', () => {
    expect(oauthConfluenceAuth(context()).kind).toBe('oauth');
  });
});
