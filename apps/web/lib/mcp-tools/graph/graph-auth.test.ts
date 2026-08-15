/**
 * `oauthGraphAuth` and `deniedGraphAuth` in isolation.
 *
 * Narrower than the other three connectors' auth tests because the
 * interface itself is narrower — see graph-auth.ts's header for why
 * resolve() takes no requiredScopes and there is no fetch() to wrap: Graph's
 * client.ts already separated "resolve a credential" from "make a call",
 * and this only had to make the first half swappable.
 */

jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { upn: 'alice@example.com' },
    },
  })),
  refreshGrantTokens: jest.fn(),
  MICROSOFT: 'microsoft',
  MicrosoftAdapter: class {},
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@/lib/microsoft-app', () => ({ getMicrosoftApp: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

/** Accepts any chain, always resolves the one row resolveGraphAccess needs. */
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

import { oauthGraphAuth, deniedGraphAuth } from './graph-auth';
import type { GraphCallContext } from './client';

const context = (overrides: Partial<GraphCallContext> = {}): GraphCallContext => ({
  tenantId: 'tenant-1',
  subject: 'subject-1',
  origin: 'https://renkei.example.com',
  ...overrides,
});

describe('oauthGraphAuth', () => {
  it('resolves the real access token through the mocked grant chain', async () => {
    const auth = oauthGraphAuth(context());

    const access = await auth.resolve();

    expect(access).toEqual({
      accessToken: 'token-1',
      upn: 'alice@example.com',
      accountId: 'acct-1',
    });
  });

  it('reports an unresolved grant as a string, not a thrown error', async () => {
    // No subject is resolveGraphAccess's own "not signed in" failure — the
    // same union every handler already checks with `typeof access === 'string'`.
    const auth = oauthGraphAuth(context({ subject: undefined }));

    const access = await auth.resolve();

    expect(typeof access).toBe('string');
    expect(access).toContain('No signed-in identity');
  });
});

describe('deniedGraphAuth', () => {
  it('always refuses, without touching the database', async () => {
    const auth = deniedGraphAuth();

    const access = await auth.resolve();

    expect(typeof access).toBe('string');
    expect(access).toContain('No Microsoft test credential is configured');
  });
});
