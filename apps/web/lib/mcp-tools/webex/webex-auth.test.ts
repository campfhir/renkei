/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthWebexAuth` and `deniedWebexAuth` in isolation — the scope gate, and
 * that a denied credential never reaches the network. `webex.test.ts` stubs
 * this interface entirely to test the TOOLS; this file is the other half,
 * proving the concrete implementations do what WebexAuth promises.
 */

jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      accountId: 'acct-1',
      metadata: { personEmail: 'alice@example.com' },
    },
  })),
  refreshGrantTokens: jest.fn(),
  WEBEX_USER: 'webex-user',
  WebexUserAdapter: class {},
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@/lib/webex-app', () => ({ getWebexUserApp: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

/** Accepts any chain, always resolves the one row resolveWebexAccess needs. */
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

import { oauthWebexAuth, deniedWebexAuth } from './webex-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
    origin: 'https://renkei.example.com',
    ...overrides,
  }) as unknown as MCPToolContext;

const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(
    async () => new Response('{"id":"msg-1"}', { status: 200 })
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('oauthWebexAuth — the call-time scope gate', () => {
  it('refuses a call the grant does not cover, without touching the network', async () => {
    const auth = oauthWebexAuth(context({ webexScopes: ['spark:messages_read'] }));

    const response = await auth.fetch(['spark:messages_write'], '/messages', { method: 'POST' });

    expect(response.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('spark:messages_write');
  });

  it('allows a call the grant does cover', async () => {
    const auth = oauthWebexAuth(context({ webexScopes: ['spark:rooms_read'] }));

    const response = await auth.fetch(['spark:rooms_read'], '/rooms');

    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows everything when webexScopes is undefined', async () => {
    const auth = oauthWebexAuth(context({ webexScopes: undefined }));

    const response = await auth.fetch(['spark:messages_write'], '/messages');

    expect(response.ok).toBe(true);
  });
});

describe('oauthWebexAuth — the request itself', () => {
  it('sends a bearer token against the webexapis.com base', async () => {
    const auth = oauthWebexAuth(context());

    await auth.fetch([], '/rooms?max=10');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://webexapis.com/v1/rooms?max=10');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
  });

  it('reports an unresolved grant as a Response, not a thrown error', async () => {
    // No subject on the context is resolveWebexAccess's own "not signed in"
    // failure — proving it comes back through fetch()'s ordinary Response
    // channel, exactly like a missing scope or a real 4xx would.
    const auth = oauthWebexAuth(context({ subject: undefined }));

    const response = await auth.fetch([], '/rooms');

    expect(response.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('No signed-in subject');
  });
});

describe('deniedWebexAuth', () => {
  it('refuses every call without touching the network', async () => {
    const auth = deniedWebexAuth();

    const response = await auth.fetch(['spark:rooms_read'], '/rooms');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
