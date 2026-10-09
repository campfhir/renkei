/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthWebexAuth` and `deniedWebexAuth` in isolation — the scope gate, and
 * that a denied credential never reaches the network. `webex.test.ts` stubs
 * this interface entirely to test the TOOLS; this file is the other half,
 * proving the concrete implementations do what WebexAuth promises.
 *
 * The delegate is faked at the client boundary: `describe` answers what a
 * grant row would, and the grant's fetcher rides global fetch so the
 * suite's fetch mock sees each request as the delegate would forward it.
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

import { oauthWebexAuth, deniedWebexAuth, resolveWebexAccess } from './webex-auth';
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
    val: { accountId: 'acct-1', metadata: { personEmail: 'alice@example.com' } },
  });
  global.fetch = jest.fn(
    async () => new Response('{"id":"msg-1"}', { status: 200 })
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('resolveWebexAccess', () => {
  it('asks the delegate about the caller’s grant and hands back its fetcher plus the address', async () => {
    const access = await resolveWebexAccess(context());

    expect(typeof access).not.toBe('string');
    if (typeof access === 'string') return;
    expect(access.personEmail).toBe('alice@example.com');
    expect(access.auth.grantKey).toBe('webex:tenant-1:subject-1');
    expect(mockDescribe).toHaveBeenCalledWith({
      provider: 'webex',
      subject: 'subject-1',
    });
  });

  it('phrases a missing grant the way the connectors page would', async () => {
    mockDescribe.mockResolvedValue({ ok: false, err: { type: 'NO_GRANT' } });

    const access = await resolveWebexAccess(context());

    expect(access).toBe(
      'WebEx is not connected. Connect it on the Connectors page, then try again.'
    );
  });

  it('refuses without a subject before asking the delegate anything', async () => {
    const access = await resolveWebexAccess(context({ subject: undefined }));

    expect(access).toContain('No signed-in subject');
    expect(mockDescribe).not.toHaveBeenCalled();
  });
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
  it('sends the request on the grant fetcher against the webexapis.com base, with no token of its own', async () => {
    const auth = oauthWebexAuth(context());

    await auth.fetch([], '/rooms?max=10');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://webexapis.com/v1/rooms?max=10');
    // The delegate attaches Authorization; nothing here may set one.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sets Content-Type: application/json for a JSON string body', async () => {
    const auth = oauthWebexAuth(context());

    await auth.fetch([], '/messages', { method: 'POST', body: JSON.stringify({ markdown: 'hi' }) });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('leaves Content-Type unset for a FormData body, so fetch sets its own boundary', async () => {
    const auth = oauthWebexAuth(context());
    const form = new FormData();
    form.append('roomId', 'room-1');

    await auth.fetch([], '/messages', { method: 'POST', body: form });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
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

  it('turns a delegate refusal into the resolver’s own words, not a WebEx answer', async () => {
    // The delegate never reached WebEx: the grant was revoked between the
    // describe and the call. Its refusal carries x-delegate-error.
    global.fetch = jest.fn(
      async () =>
        new Response('{"error":{"type":"GRANT_REVOKED"}}', {
          status: 403,
          headers: { 'x-delegate-error': 'GRANT_REVOKED' },
        })
    ) as unknown as typeof fetch;
    const auth = oauthWebexAuth(context());

    const response = await auth.fetch([], '/rooms');

    expect(response.ok).toBe(false);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('revoked');
    expect(body.message).toContain('Reconnect');
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
