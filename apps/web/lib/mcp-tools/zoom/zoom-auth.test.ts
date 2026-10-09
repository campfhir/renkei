/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthZoomAuth` and `deniedZoomAuth` in isolation — the scope gate, and
 * that a denied credential never reaches the network. Mirrors
 * webex/webex-auth.test.ts, delegate fake included.
 */

const mockDescribe = jest.fn();

jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({ describe: (...args: unknown[]) => mockDescribe(...args) }),
    grantFetch: (grant: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch((url, init) => fetch(url, init), actual.grantKeyOf(grant)),
  };
});
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import { oauthZoomAuth, deniedZoomAuth, resolveZoomAccess } from './zoom-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    subject: 'subject-1',
    origin: 'https://renkei.example.com',
    ...overrides,
  }) as unknown as MCPToolContext;

const realFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockDescribe.mockResolvedValue({
    ok: true,
    val: { accountId: 'acct-1', metadata: { email: 'alice@example.com' } },
  });
  global.fetch = jest.fn(
    async () => new Response('{"id":"meeting-1"}', { status: 200 })
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('resolveZoomAccess', () => {
  it('asks the delegate about the caller’s grant and hands back its fetcher plus the email', async () => {
    const access = await resolveZoomAccess(context());

    expect(typeof access).not.toBe('string');
    if (typeof access === 'string') return;
    expect(access.email).toBe('alice@example.com');
    expect(access.auth.grantKey).toBe('zoom:tenant-1:subject-1');
    expect(mockDescribe).toHaveBeenCalledWith({
      provider: 'zoom',
      subject: 'subject-1',
    });
  });

  it('phrases a revoked grant the way the resolver always did', async () => {
    mockDescribe.mockResolvedValue({ ok: false, err: { type: 'GRANT_REVOKED' } });

    const access = await resolveZoomAccess(context());

    expect(access).toBe(
      'Your Zoom authorization was revoked. Reconnect it on the Connectors page.'
    );
  });
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
  it('sends the request on the grant fetcher against the api.zoom.us base, with no token of its own', async () => {
    const auth = oauthZoomAuth(context());

    await auth.fetch([], '/users/me/meetings?type=upcoming');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.zoom.us/v2/users/me/meetings?type=upcoming');
    // The delegate attaches Authorization; nothing here may set one.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reports an unresolved grant as a Response, not a thrown error', async () => {
    const auth = oauthZoomAuth(context({ subject: undefined }));

    const response = await auth.fetch([], '/users/me/meetings');

    expect(response.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('No signed-in subject');
  });

  it('turns a delegate refusal into the resolver’s own words, not a Zoom answer', async () => {
    global.fetch = jest.fn(
      async () =>
        new Response('{"error":{"type":"REFRESH_FAILED"}}', {
          status: 502,
          headers: { 'x-delegate-error': 'REFRESH_FAILED' },
        })
    ) as unknown as typeof fetch;
    const auth = oauthZoomAuth(context());

    const response = await auth.fetch([], '/users/me/meetings');

    expect(response.ok).toBe(false);
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('Could not refresh the Zoom token; try again shortly.');
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
