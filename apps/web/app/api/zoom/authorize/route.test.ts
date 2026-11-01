/**
 * GET /api/zoom/authorize — where the Zoom card's Connect link goes. The
 * person may narrow the org's ceiling, never widen it; the narrowed
 * selection plus the scope that identifies them is what Zoom is asked for
 * and what the pending row records for the callback. On the memory store.
 * (The card's link itself is scope-connect-panel.model.test.ts's; the
 * browser walk through the fake consent is e2e/connectors.spec.ts's.)
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@/lib/get-origin', () => ({ getOrigin: jest.fn() }));
jest.mock('@/lib/zoom-app', () => ({ ZOOM_CONNECTOR: 'zoom', getZoomApp: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET } from './route';
import { connectStateCookieName } from '@/lib/connect-flow-binding';

const { getSessionFromRequest: mockSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');
const { getOrigin: mockOrigin } = jest.requireMock<{ getOrigin: jest.Mock }>('@/lib/get-origin');
const { getZoomApp: mockZoomApp } = jest.requireMock<{ getZoomApp: jest.Mock }>('@/lib/zoom-app');

const ME = 'zoom-person@example.com';
const CEILING = 'meeting:read:meeting recording:read:recording user:read:user';

const authorize = (scopes?: string) =>
  GET(
    new NextRequest(
      `http://test.local/api/zoom/authorize${scopes === undefined ? '' : `?scopes=${encodeURIComponent(scopes)}`}`
    )
  );

/** The pending row the callback will look up, by the state Zoom is sent. */
async function pendingFor(location: string) {
  const state = new URL(location).searchParams.get('state');
  expect(state).toBeTruthy();
  return getDataStore().pendingSignins.findByState(state ?? '');
}

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  mockSession.mockResolvedValue({ subject: ME, roles: ['renkei-user'] });
  mockOrigin.mockResolvedValue({ ok: true, val: 'http://test.local' });
  mockZoomApp.mockResolvedValue({
    clientId: 'zoom-client',
    clientSecret: 'secret',
    secretToken: null,
    scopes: CEILING,
    redirectUri: 'http://test.local/api/oauth/callback',
  });
});

afterEach(() => resetDataStore());

describe('GET /api/zoom/authorize', () => {
  it('refuses someone not signed in', async () => {
    mockSession.mockResolvedValue(null);
    expect((await authorize()).status).toBe(401);
  });

  it('answers 503 while the org has no Zoom app registered', async () => {
    mockZoomApp.mockResolvedValue(null);
    expect((await authorize()).status).toBe(503);
  });

  it('refuses a scope outside the org ceiling, naming it, and starts no flow', async () => {
    const response = await authorize('meeting:read:meeting meeting:write:meeting');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Scopes not allowed by this organization: meeting:write:meeting',
    });
    expect(response.headers.get('location')).toBeNull();
  });

  it('asks Zoom for the narrowed selection plus the identity scope, and records it for the callback', async () => {
    const response = await authorize('meeting:read:meeting');
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = response.headers.get('location') ?? '';
    const consent = new URL(location);
    expect(consent.origin + consent.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(consent.searchParams.get('client_id')).toBe('zoom-client');
    expect(consent.searchParams.get('scope')).toBe('meeting:read:meeting user:read:user');

    const pending = await pendingFor(location);
    expect(pending).toMatchObject({
      subject: ME,
      provider: 'zoom',
      scopes: 'meeting:read:meeting user:read:user',
    });
    // Bound to this browser: the callback requires the cookie.
    const state = consent.searchParams.get('state') ?? '';
    expect(response.headers.get('set-cookie')).toContain(`${connectStateCookieName()}=${state}`);
  });

  // Every authorize route reads an empty selection as "no selection" and
  // falls back to the ceiling; pinned here as it stands.
  it('an empty selection asks for the whole ceiling', async () => {
    const location = (await authorize('')).headers.get('location') ?? '';
    expect(new URL(location).searchParams.get('scope')).toBe(CEILING);
    expect(await pendingFor(location)).toMatchObject({ scopes: CEILING });
  });
});
