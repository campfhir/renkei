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

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/queue', () => ({ webhookEventsQueue: () => ({ producer: {} }) }));
jest.mock('@renkei/delegate-client', () => ({ delegateClient: () => ({}) }));
jest.mock('@/lib/mcp-tools/common', () => ({ cacheUserDisplayName: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET } from './route';
import { connectStateCookieName } from '@/lib/connect-flow-binding';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getSessionFromRequest: mockGetSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const TENANT = '00000000-0000-4000-8000-000000000001';
const STATE = 'f6a1c4b2-0d3e-4f5a-8b6c-7d8e9f0a1b2c';
const SUBJECT = 'alice@example.com';

/**
 * A Kysely stand-in for exactly what the refusals touch: the pending row's
 * lookup and its single-use delete. Any other table read means the callback
 * went further than it should have, so it throws.
 */
function stubDb(pending: Record<string, unknown> | undefined) {
  const deleted: string[] = [];
  const db = {
    selectFrom(table: string) {
      if (table !== 'pending_oidc_signin') throw new Error(`unexpected read of ${table}`);
      const chain = {
        select: () => chain,
        where: () => chain,
        executeTakeFirst: async () => pending,
      };
      return chain;
    },
    deleteFrom(table: string) {
      return {
        where(_column: string, _op: string, value: string) {
          deleted.push(`${table}:${value}`);
          return { async execute() {} };
        },
      };
    },
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { deleted };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    subject: SUBJECT,
    provider: 'microsoft',
    scopes: 'openid',
    code_verifier: null,
    ...overrides,
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
    mockGetDatabase.mockReset();
    mockGetSession.mockReset();
  });

  it('refuses a callback with no binding cookie and consumes the state', async () => {
    const { deleted } = stubDb(pendingRow());
    mockGetSession.mockResolvedValue(session(SUBJECT));

    const response = await GET(callback({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid state' });
    expect(deleted).toEqual([`pending_oidc_signin:${STATE}`]);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('refuses a callback whose cookie names a different state', async () => {
    const { deleted } = stubDb(pendingRow());
    mockGetSession.mockResolvedValue(session(SUBJECT));

    const response = await GET(
      callback({ [connectStateCookieName(TENANT)]: 'the-attackers-own-state' })
    );

    expect(response.status).toBe(400);
    expect(deleted).toEqual([`pending_oidc_signin:${STATE}`]);
  });

  it('refuses a bound callback completed by a different subject', async () => {
    const { deleted } = stubDb(pendingRow());
    mockGetSession.mockResolvedValue(session('mallory@example.com'));

    const response = await GET(callback({ [connectStateCookieName(TENANT)]: STATE }));

    expect(response.status).toBe(403);
    expect(mockGetSession).toHaveBeenCalledWith(expect.anything(), TENANT);
    expect(deleted).toEqual([`pending_oidc_signin:${STATE}`]);
  });

  it('refuses a bound callback from a browser with no session at all', async () => {
    const { deleted } = stubDb(pendingRow());
    mockGetSession.mockResolvedValue(null);

    const response = await GET(callback({ [connectStateCookieName(TENANT)]: STATE }));

    expect(response.status).toBe(403);
    expect(deleted).toEqual([`pending_oidc_signin:${STATE}`]);
  });

  it('clears the binding cookie on the refusal', async () => {
    stubDb(pendingRow());
    mockGetSession.mockResolvedValue(null);

    const response = await GET(callback({ [connectStateCookieName(TENANT)]: STATE }));

    const cookie = response.cookies.get(connectStateCookieName(TENANT));
    expect(cookie?.value ?? '').toBe('');
    expect(cookie?.maxAge ?? 0).toBe(0);
  });

  it('still answers an unknown state as invalid without a cookie check', async () => {
    const { deleted } = stubDb(undefined);

    const response = await GET(callback({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid or expired state' });
    expect(deleted).toEqual([]);
  });
});
