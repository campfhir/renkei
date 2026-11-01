/**
 * Operator sign-out-everywhere: operator-only, never on oneself, and it
 * removes the person's sessions AND both MCP token tables — and then, with
 * a client connected the way a real one connects (authorize, consent,
 * code for tokens), the browser cookie, the bearer token and the refresh
 * token really stop opening anything. access-revoke-sessions.spec.ts
 * checked that last part through two browsers before; it keeps the
 * button, its outcome line and the real consent-page code flow.
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { randomBytes, randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { hashToken, resolveAccessToken } from '@/lib/mcp-token';
import { computeS256 } from '@/lib/oauth-pkce';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { GET as authorize, POST as consent } from '@/app/api/mcp/oauth/authorize/route';
import { POST as token } from '@/app/api/mcp/oauth/token/route';
import { POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

const TARGET = 'bob@example.com';
const OTHER = 'ann@example.com';
const EXPIRES = new Date('2030-01-01T00:00:00.000Z');

/** Two of everything for the target, one of everything for someone else. */
async function seededStore(): Promise<MemoryDataStore> {
  const store = createMemoryDataStore();
  const sid = (n: number) => `00000000-0000-4000-8000-00000000050${n}`;
  const rid = (n: number) => `00000000-0000-4000-8000-00000000060${n}`;
  await store.seed({
    sessions: [
      { id: sid(1), subject: TARGET, expires_at: EXPIRES },
      { id: sid(2), subject: TARGET, expires_at: EXPIRES },
      { id: sid(3), subject: OTHER, expires_at: EXPIRES },
    ],
    oauth_clients: [{ client_id: 'c', client_secret_hash: 'h', redirect_uris: ['https://x'] }],
    oauth_access_tokens: [
      { token_hash: 'a1', client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'a2', client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'a3', client_id: 'c', subject: OTHER, expires_at: EXPIRES },
    ],
    oauth_refresh_tokens: [
      { token_hash: 'r1', token_id: rid(1), client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'r2', token_id: rid(2), client_id: 'c', subject: TARGET, expires_at: EXPIRES },
      { token_hash: 'r3', token_id: rid(3), client_id: 'c', subject: OTHER, expires_at: EXPIRES },
    ],
  });
  registerDataStore(store);
  return store;
}

function request(subject = TARGET) {
  return {
    request: new NextRequest(
      `http://localhost/api/admin/acme/access/${encodeURIComponent(subject)}/revoke-sessions`,
      { method: 'POST' }
    ),
    context: { params: Promise.resolve({ subject: encodeURIComponent(subject) }) },
  };
}

const subjects = (store: MemoryDataStore) => ({
  sessions: store.tables.select('sessions').map((r) => r.subject),
  accessTokens: store.tables.select('oauth_access_tokens').map((r) => r.subject),
  refreshTokens: store.tables.select('oauth_refresh_tokens').map((r) => r.subject),
});

describe('POST /api/admin/access/{subject}/revoke-sessions', () => {
  beforeEach(() => {
    mockCheckAccess.mockReset();
    mockAudit.mockReset();
  });
  afterAll(() => {
    resetDataStore();
  });

  it('refuses a caller who is not an operator before touching anything', async () => {
    const store = await seededStore();
    mockCheckAccess.mockResolvedValue(null);
    const { request: req, context } = request();
    const response = await POST(req, context);
    expect(response.status).toBe(401);
    expect(subjects(store).sessions).toHaveLength(3);
  });

  it("deletes the person's sessions, access tokens and refresh tokens, and audits it", async () => {
    const store = await seededStore();
    mockCheckAccess.mockResolvedValue({ subject: 'op@example.com', roles: ['renkei-operator'] });
    const { request: req, context } = request();

    const response = await POST(req, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      revoked: { sessions: 2, accessTokens: 2, refreshTokens: 2 },
    });
    expect(subjects(store)).toEqual({
      sessions: [OTHER],
      accessTokens: [OTHER],
      refreshTokens: [OTHER],
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'op@example.com',
        action: 'user.sessions_revoked',
        targetLabel: TARGET,
      })
    );
  });

  it('will not sign the operator themselves out from here', async () => {
    const store = await seededStore();
    mockCheckAccess.mockResolvedValue({ subject: TARGET, roles: ['renkei-operator'] });
    const { request: req, context } = request(TARGET);
    const response = await POST(req, context);
    expect(response.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(subjects(store).sessions).toHaveLength(3);
  });
});

describe('after sign out everywhere, nothing the person held opens anything', () => {
  const CALLBACK = 'http://127.0.0.1:47392/callback';
  const clientId = `client_${randomUUID().slice(0, 8)}`;
  const clientSecret = 'client-secret-for-tests';
  const sessionId = randomUUID();
  const verifier = randomBytes(32).toString('base64url');

  afterEach(() => resetDataStore());

  const cookie = { cookie: `renkei_session=${sessionId}` };

  async function form(url: string, body: Record<string, string>, headers = {}) {
    resetInboundLimits();
    return new NextRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    });
  }

  /** The target signs in and connects an MCP client: consent, then a code for tokens. */
  async function connectClient(): Promise<{ accessToken: string; refreshToken: string }> {
    registerDataStore(createMemoryDataStore());
    const store = getDataStore();
    await store.sessions.create({
      id: sessionId,
      subject: TARGET,
      roles: ['renkei-user'],
      expiresAt: EXPIRES,
    });
    await store.oauthConsents.registerClient({
      clientId,
      clientSecretHash: hashToken(clientSecret),
      clientName: 'Revoke client',
      redirectUris: [CALLBACK],
      responseTypes: ['code'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: 'revoke',
      code_challenge: computeS256(verifier),
      code_challenge_method: 'S256',
    });
    const asked = await authorize(
      new NextRequest(`http://localhost/api/mcp/oauth/authorize?${query.toString()}`, {
        headers: cookie,
      })
    );
    const requestId = new URL(asked.headers.get('location')!).searchParams.get('request')!;
    const origin = await getOrigin(new NextRequest('http://localhost/x'));
    if (!origin.ok) throw new Error('no origin');
    const allowed = await consent(
      await form(
        'http://localhost/api/mcp/oauth/authorize',
        { request: requestId, decision: 'allow' },
        { ...cookie, origin: origin.val }
      )
    );
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    const granted = await token(
      await form('http://localhost/api/mcp/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        client_id: clientId,
        client_secret: clientSecret,
      })
    );
    expect(granted.status).toBe(200);
    const body: { access_token: string; refresh_token: string } = await granted.json();
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  }

  const refresh = async (refreshToken: string) =>
    token(
      await form('http://localhost/api/mcp/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      })
    );

  const signedIn = () =>
    getSessionFromRequest(new NextRequest('http://localhost/api/keys', { headers: cookie }));

  it('ends 1 session and 2 tokens; the cookie, the bearer and the refresh token are refused', async () => {
    const tokens = await connectClient();
    expect(await signedIn()).not.toBeNull();
    expect(await resolveAccessToken(tokens.accessToken)).not.toBeNull();

    mockCheckAccess.mockResolvedValue({ subject: 'op@example.com', roles: ['renkei-operator'] });
    const { request: req, context } = request(TARGET);
    const response = await POST(req, context);
    expect(await response.json()).toEqual({
      success: true,
      revoked: { sessions: 1, accessTokens: 1, refreshTokens: 1 },
    });

    expect(await signedIn()).toBeNull();
    expect(await resolveAccessToken(tokens.accessToken)).toBeNull();
    expect((await refresh(tokens.refreshToken)).ok).toBe(false);
  });

  it('without the sign-out, the same refresh token still works', async () => {
    const tokens = await connectClient();
    expect((await refresh(tokens.refreshToken)).status).toBe(200);
  });
});
