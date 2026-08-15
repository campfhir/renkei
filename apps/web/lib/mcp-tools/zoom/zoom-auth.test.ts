/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthZoomAuth` and `deniedZoomAuth` in isolation — the scope gate, and
 * that a denied credential never reaches the network. Mirrors
 * webex/webex-auth.test.ts.
 */

jest.mock('@renkei/provider-grants', () => ({
  getGrant: jest.fn(async () => ({
    ok: true,
    val: {
      accessToken: 'token-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      accountId: 'acct-1',
      metadata: { email: 'alice@example.com' },
    },
  })),
  refreshGrantTokens: jest.fn(),
  ZOOM: 'zoom',
  ZoomAdapter: class {},
}));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: true, val: 'key' }) }));
jest.mock('@/lib/zoom-app', () => ({ getZoomApp: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

/** Accepts any chain, always resolves the one row resolveZoomAccess needs. */
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

import { oauthZoomAuth, deniedZoomAuth } from './zoom-auth';
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
    async () => new Response('{"id":"meeting-1"}', { status: 200 })
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('oauthZoomAuth — the call-time scope gate', () => {
  it('refuses a call the grant does not cover, without touching the network', async () => {
    const auth = oauthZoomAuth(context({ zoomScopes: ['meeting:read:meeting'] }));

    const response = await auth.fetch(['meeting:write:meeting'], '/users/me/meetings', {
      method: 'POST',
    });

    expect(response.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('meeting:write:meeting');
  });

  it('allows a call the grant does cover', async () => {
    const auth = oauthZoomAuth(context({ zoomScopes: ['meeting:read:list_meetings'] }));

    const response = await auth.fetch(['meeting:read:list_meetings'], '/users/me/meetings');

    expect(response.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows everything when zoomScopes is undefined', async () => {
    const auth = oauthZoomAuth(context({ zoomScopes: undefined }));

    const response = await auth.fetch(['meeting:delete:meeting'], '/meetings/123');

    expect(response.ok).toBe(true);
  });
});

describe('oauthZoomAuth — the request itself', () => {
  it('sends a bearer token against the api.zoom.us base', async () => {
    const auth = oauthZoomAuth(context());

    await auth.fetch([], '/users/me/meetings?type=upcoming');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.zoom.us/v2/users/me/meetings?type=upcoming');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
  });

  it('reports an unresolved grant as a Response, not a thrown error', async () => {
    const auth = oauthZoomAuth(context({ subject: undefined }));

    const response = await auth.fetch([], '/users/me/meetings');

    expect(response.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('No signed-in subject');
  });
});

describe('deniedZoomAuth', () => {
  it('refuses every call without touching the network', async () => {
    const auth = deniedZoomAuth();

    const response = await auth.fetch(['meeting:read:list_meetings'], '/users/me/meetings');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
