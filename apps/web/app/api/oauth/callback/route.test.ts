/**
 * The shared connect callback's browser binding (lib/connect-flow-binding.ts).
 *
 * Before it, the callback looked the pending row up by state alone, so a
 * callback URL captured from the attacker's own flow and loaded in a
 * victim's browser completed in the victim's browser and planted the
 * attacker's provider grant on whichever subject the row named. These cases
 * pin the two refusals that close it — no/wrong binding cookie, and a
 * session that is not the subject who started the flow — and that each one
 * consumes the state so the URL cannot be retried from another browser.
 * Nothing here reaches a provider: every case stops before dispatch.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/queue', () => ({ webhookEventsQueue: () => ({ producer: {} }) }));
jest.mock('@renkei/delegate-client', () => ({ delegateClient: () => ({}) }));
jest.mock('@/lib/mcp-tools/common', () => ({ cacheUserDisplayName: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type PendingSigninInput,
} from '@renkei/db';
import { GET } from './route';
import { connectStateCookieName } from '@/lib/connect-flow-binding';

const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const STATE = 'f6a1c4b2-0d3e-4f5a-8b6c-7d8e9f0a1b2c';
const SUBJECT = 'alice@example.com';

/**
 * A memory data store holding the pending row (if any), recording each
 * single-use delete of a state — what the refusals touch.
 */
async function stubStore(pending: PendingSigninInput | undefined) {
  const deleted: string[] = [];
  const store = createMemoryDataStore();
  if (pending) await store.pendingSignins.create(pending);
  registerDataStore({
    ...store,
    pendingSignins: {
      ...store.pendingSignins,
      deleteByState: (state) => {
        deleted.push(state);
        return store.pendingSignins.deleteByState(state);
      },
    },
  });
  return { deleted, store };
}

function pendingRow(): PendingSigninInput {
  return {
    id: '00000000-0000-4000-8000-00000000ca11',
    state: STATE,
    nonce: 'nonce',
    expiresAt: new Date(Date.now() + 60_000),
    subject: SUBJECT,
    provider: 'microsoft',
    scopes: 'openid',
  };
}

function callback(cookies: Record<string, string>): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest(`http://localhost/api/oauth/callback?code=abc&state=${STATE}`, {
    headers: cookie ? { cookie } : {},
  });
}

function session(subject: string) {
  return { id: 's', subject, roles: ['renkei-user'], expiresAt: new Date() };
}

describe('GET /api/oauth/callback browser binding', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  afterEach(() => resetDataStore());

  it('refuses a callback with no binding cookie and consumes the state', async () => {
    const { deleted, store } = await stubStore(pendingRow());
    mockGetSession.mockResolvedValue(session(SUBJECT));

    const response = await GET(callback({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid state' });
    expect(deleted).toEqual([STATE]);
    expect(await store.pendingSignins.findByState(STATE)).toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('refuses a callback whose cookie names a different state', async () => {
    const { deleted } = await stubStore(pendingRow());
    mockGetSession.mockResolvedValue(session(SUBJECT));

    const response = await GET(callback({ [connectStateCookieName()]: 'the-attackers-own-state' }));

    expect(response.status).toBe(400);
    expect(deleted).toEqual([STATE]);
  });

  it('refuses a bound callback completed by a different subject', async () => {
    const { deleted } = await stubStore(pendingRow());
    mockGetSession.mockResolvedValue(session('mallory@example.com'));

    const response = await GET(callback({ [connectStateCookieName()]: STATE }));

    expect(response.status).toBe(403);
    expect(mockGetSession).toHaveBeenCalledWith(expect.anything());
    expect(deleted).toEqual([STATE]);
  });

  it('refuses a bound callback from a browser with no session at all', async () => {
    const { deleted } = await stubStore(pendingRow());
    mockGetSession.mockResolvedValue(null);

    const response = await GET(callback({ [connectStateCookieName()]: STATE }));

    expect(response.status).toBe(403);
    expect(deleted).toEqual([STATE]);
  });

  it('clears the binding cookie on the refusal', async () => {
    await stubStore(pendingRow());
    mockGetSession.mockResolvedValue(null);

    const response = await GET(callback({ [connectStateCookieName()]: STATE }));

    const cookie = response.cookies.get(connectStateCookieName());
    expect(cookie?.value ?? '').toBe('');
    expect(cookie?.maxAge ?? 0).toBe(0);
  });

  it('still answers an unknown state as invalid without a cookie check', async () => {
    const { deleted } = await stubStore(undefined);

    const response = await GET(callback({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid or expired state' });
    expect(deleted).toEqual([]);
  });
});
