/**
 * The authorization endpoint's PKCE refusals (GET /api/mcp/oauth/authorize),
 * on the memory store: a request without an S256 challenge never reaches
 * the consent page — the client is sent back to its own registered
 * redirect URI with `invalid_request`, its state, and no code — and no
 * consent request is recorded to answer later. oauth-consent.spec.ts
 * checked this through a signed-in browser before; route.db.test.ts runs
 * the whole consent step against Postgres when DATABASE_URL is set.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));

import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { hashToken } from '@/lib/mcp-token';
import { computeS256 } from '@/lib/oauth-pkce';
import { GET } from './route';

const { getSessionFromRequest: mockSession } = jest.requireMock<{
  getSessionFromRequest: jest.Mock;
}>('@/lib/session');

const CALLBACK = 'http://127.0.0.1:47391/callback';
const clientId = `client_${randomUUID().slice(0, 8)}`;
const challenge = computeS256(randomBytes(32).toString('base64url'));

beforeEach(async () => {
  registerDataStore(createMemoryDataStore());
  mockSession.mockResolvedValue({
    id: randomUUID(),
    subject: 'person@example.com',
    roles: ['renkei-user'],
  });
  await getDataStore().oauthConsents.registerClient({
    clientId,
    clientSecretHash: hashToken('client-secret-for-tests'),
    clientName: 'Claude Code (test)',
    redirectUris: [CALLBACK],
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
});

afterEach(() => {
  resetDataStore();
  jest.clearAllMocks();
});

function authorize(overrides: Record<string, string | null> = {}) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: 'no-pkce',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) query.delete(key);
    else query.set(key, value);
  }
  return GET(new NextRequest(`http://localhost/api/mcp/oauth/authorize?${query.toString()}`));
}

describe('a request without PKCE never reaches the consent page', () => {
  it.each([
    [
      'no challenge at all',
      { code_challenge: null, code_challenge_method: null },
      /code_challenge/,
    ],
    ['the plain method', { code_challenge_method: 'plain' }, /S256/],
    ['no method', { code_challenge_method: null }, /S256/],
    ['a challenge that is not a SHA-256', { code_challenge: 'short' }, /43 characters/],
  ])('%s: back to the client with invalid_request, its state and no code', async (_, bad, why) => {
    const response = await authorize(bad);
    expect(response.status).toBe(303);
    const landed = new URL(response.headers.get('location')!);
    expect(`${landed.origin}${landed.pathname}`).toBe(CALLBACK);
    expect(landed.searchParams.get('error')).toBe('invalid_request');
    expect(landed.searchParams.get('error_description')).toMatch(why);
    expect(landed.searchParams.get('state')).toBe('no-pkce');
    expect(landed.searchParams.get('code')).toBeNull();
    expect(landed.searchParams.get('request')).toBeNull();
  });

  it('turns away a signed-out browser without PKCE too, before sending it to sign in', async () => {
    mockSession.mockResolvedValue(null);
    const response = await authorize({ code_challenge: null, code_challenge_method: null });
    const landed = new URL(response.headers.get('location')!);
    expect(`${landed.origin}${landed.pathname}`).toBe(CALLBACK);
    expect(landed.searchParams.get('error')).toBe('invalid_request');
  });

  it('with an S256 challenge, the same browser lands on the consent page instead', async () => {
    const response = await authorize({ state: 'with-pkce' });
    expect(response.status).toBe(303);
    const landed = new URL(response.headers.get('location')!);
    expect(landed.pathname).toBe('/oauth/consent');
    expect(landed.searchParams.get('code')).toBeNull();
    const requestId = landed.searchParams.get('request');
    expect(await getDataStore().oauthConsents.getRequest(requestId!)).toMatchObject({
      clientId,
      state: 'with-pkce',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
  });

  it('never redirects anywhere for a redirect URI the client did not register', async () => {
    const response = await authorize({
      redirect_uri: 'http://attacker.example/callback',
      code_challenge: null,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });
});
