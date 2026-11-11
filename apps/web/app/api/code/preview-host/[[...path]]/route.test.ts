/**
 * The preview host's one route: it answers only for that host, relays a
 * share link by its token, and knows a member by the preview host's own
 * cookie — handed over by the app, never the app's session.
 */

const relay = jest.fn(async (..._args: unknown[]) => new Response('relayed'));
const mayView = jest.fn(async (..._args: unknown[]) => true);
let host = 'preview.example.com';
jest.mock('@/lib/code/previews', () => ({ previewRelay: (...args: unknown[]) => relay(...args) }));
jest.mock('@/lib/code/preview-host-server', () => ({
  codePreviewHost: async () => host,
  mayViewPreview: (...args: unknown[]) => mayView(...args),
  previewHostKey: () =>
    jest.requireActual('@/lib/code/preview-host').previewSigningKey(Buffer.alloc(32, 3)),
}));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: () => 'https://app.example.com' }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  PREVIEW_SESSION_COOKIE,
  mintPreviewSession,
  mintPreviewTicket,
  openPreviewSession,
  openPreviewTicket,
  previewSigningKey,
} from '@/lib/code/preview-host';
import { GET, POST } from './route';
import { GET as enterGET } from '../../preview-enter/route';

const { getSessionFromRequest: mockSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const key = previewSigningKey(Buffer.alloc(32, 3));
const PROJECT = '11111111-1111-4111-8111-111111111111';
const TOKEN = Buffer.alloc(32, 9).toString('base64url');

/** A request as the operator's proxy forwards it: the app's prefix, the preview host named. */
function onHost(path: string, init: { method?: string; cookie?: string; forHost?: string } = {}) {
  const request = new NextRequest(`https://app.internal/api/code/preview-host${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-forwarded-host': init.forHost ?? 'preview.example.com',
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
  });
  const segments = path.split('?')[0]!.split('/').filter(Boolean);
  return { request, context: { params: Promise.resolve({ path: segments }) } };
}

const call = (path: string, init?: Parameters<typeof onHost>[1]) => {
  const { request, context } = onHost(path, init);
  return (init?.method === 'POST' ? POST : GET)(request, context);
};

beforeEach(() => {
  jest.clearAllMocks();
  host = 'preview.example.com';
  mayView.mockResolvedValue(true);
});

describe('which requests it answers', () => {
  it('nothing while no preview host is set', async () => {
    host = '';
    expect((await call(`/t/${TOKEN}/`)).status).toBe(404);
    expect(relay).not.toHaveBeenCalled();
  });

  it('nothing for a request that arrived for the app’s own host', async () => {
    expect((await call(`/t/${TOKEN}/`, { forHost: 'app.example.com' })).status).toBe(404);
    expect((await call(`/p/${PROJECT}/web/app/`, { forHost: 'app.example.com' })).status).toBe(404);
    expect(relay).not.toHaveBeenCalled();
  });

  it('nothing for a path that is not a preview', async () => {
    expect((await call('/api/agents')).status).toBe(404);
    expect((await call('/')).status).toBe(404);
  });
});

describe('a share link', () => {
  it('is relayed by its token, under its own prefix on the preview host', async () => {
    const response = await call(`/t/${TOKEN}/assets/app.js?x=1`);
    expect(await response.text()).toBe('relayed');
    expect(relay).toHaveBeenCalledWith(
      expect.anything(),
      { token: TOKEN },
      { prefix: `/t/${TOKEN}/`, path: ['assets', 'app.js'] }
    );
  });

  it('is nothing when the token is not token-shaped', async () => {
    expect((await call('/t/short/')).status).toBe(404);
  });
});

describe('a member’s preview', () => {
  const path = `/p/${PROJECT}/web/app/page?x=1`;

  it('sends a page load without the preview cookie to the app to be handed over', async () => {
    const response = await call(path);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://app.example.com');
    expect(location.pathname).toBe('/api/code/preview-enter');
    expect(location.searchParams.get('to')).toBe(path);
    expect(relay).not.toHaveBeenCalled();
  });

  it('tells anything else without the cookie it is not signed in', async () => {
    expect((await call(path, { method: 'POST' })).status).toBe(401);
  });

  it('is relayed for the person the cookie names, when they may see the project', async () => {
    const cookie = `${PREVIEW_SESSION_COOKIE}=${mintPreviewSession(key, 'auth0|ann', Date.now())}`;
    const response = await call(path, { cookie });
    expect(await response.text()).toBe('relayed');
    expect(mayView).toHaveBeenCalledWith('auth0|ann', PROJECT, null);
    expect(relay).toHaveBeenCalledWith(
      expect.anything(),
      { subject: `code-project:${PROJECT}`, name: 'web' },
      { prefix: `/p/${PROJECT}/web/app/`, path: ['page'] }
    );
  });

  it('is nothing for someone the project is not shared with', async () => {
    mayView.mockResolvedValue(false);
    const cookie = `${PREVIEW_SESSION_COOKIE}=${mintPreviewSession(key, 'auth0|eve', Date.now())}`;
    expect((await call(path, { cookie })).status).toBe(404);
    expect(relay).not.toHaveBeenCalled();
  });

  it('does not take the app’s ticket, or a forged cookie, as the cookie', async () => {
    const ticket = `${PREVIEW_SESSION_COOKIE}=${mintPreviewTicket(key, 'auth0|ann', Date.now())}`;
    expect((await call(path, { cookie: ticket })).status).toBe(303);
    expect((await call(path, { cookie: `${PREVIEW_SESSION_COOKIE}=forged` })).status).toBe(303);
    expect(relay).not.toHaveBeenCalled();
  });
});

describe('the handoff', () => {
  it('the app gives a signed-in person a ticket and sends them to the preview host', async () => {
    mockSession.mockResolvedValue({ subject: 'auth0|ann', roles: ['renkei-user'] });
    const to = `/p/${PROJECT}/web/app/`;
    const response = await enterGET(
      new NextRequest(`https://app.example.com/api/code/preview-enter?to=${encodeURIComponent(to)}`)
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://preview.example.com');
    expect(location.pathname).toBe('/enter');
    expect(location.searchParams.get('to')).toBe(to);
    expect(openPreviewTicket(key, location.searchParams.get('ticket')!, Date.now())).toBe(
      'auth0|ann'
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('the app sends someone not signed in to sign in, and back', async () => {
    mockSession.mockResolvedValue(null);
    const response = await enterGET(
      new NextRequest(`https://app.example.com/api/code/preview-enter?to=/p/${PROJECT}/web/app/`)
    );
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/api/auth/oidc/login');
    expect(location.searchParams.get('redirect')).toContain('/api/code/preview-enter?to=');
  });

  it('the app hands nobody to a path that is not a preview, or while no host is set', async () => {
    mockSession.mockResolvedValue({ subject: 'auth0|ann', roles: [] });
    const bad = await enterGET(
      new NextRequest('https://app.example.com/api/code/preview-enter?to=https://evil.example/')
    );
    expect(bad.status).toBe(404);
    host = '';
    const off = await enterGET(
      new NextRequest(`https://app.example.com/api/code/preview-enter?to=/p/${PROJECT}/web/app/`)
    );
    expect(off.status).toBe(404);
  });

  it('the preview host turns a ticket into its cookie and goes on to the preview', async () => {
    const to = `/p/${PROJECT}/web/app/`;
    const ticket = mintPreviewTicket(key, 'auth0|ann', Date.now());
    const response = await call(`/enter?ticket=${ticket}&to=${encodeURIComponent(to)}`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`https://preview.example.com${to}`);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    const value = setCookie.match(new RegExp(`${PREVIEW_SESSION_COOKIE}=([^;]+)`))?.[1] ?? '';
    expect(openPreviewSession(key, decodeURIComponent(value), Date.now())).toBe('auth0|ann');
  });

  it('refuses a bad ticket, a session used as a ticket, and a way out of the host', async () => {
    const to = encodeURIComponent(`/p/${PROJECT}/web/app/`);
    expect((await call(`/enter?ticket=junk&to=${to}`)).status).toBe(403);
    const session = mintPreviewSession(key, 'auth0|ann', Date.now());
    expect((await call(`/enter?ticket=${session}&to=${to}`)).status).toBe(403);
    const ticket = mintPreviewTicket(key, 'auth0|ann', Date.now());
    const out = encodeURIComponent('https://evil.example/');
    expect((await call(`/enter?ticket=${ticket}&to=${out}`)).status).toBe(403);
  });
});
