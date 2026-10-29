/**
 * The authorization endpoint's consent step against a real database
 * (skipped without DATABASE_URL): a request without S256 PKCE is turned
 * away on the client's own redirect URI; a valid one from a signed-in
 * browser lands on the consent page instead of minting a code; only the
 * session that was shown the page may answer, only from this origin, and
 * only once; Deny sends `access_denied`; Allow mints a code the token
 * endpoint exchanges for exactly the verifier the challenge committed to,
 * and for nothing else. The client, sessions and person are this run's
 * own; nothing org-wide is cleared.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { closeDataStore, getDataStore } from '@renkei/db';
import { hashToken } from '@/lib/mcp-token';
import { resetInboundLimits } from '@/lib/inbound-rate-limit';
import { computeS256 } from '@/lib/oauth-pkce';
import { getOrigin } from '@/lib/get-origin';
import { GET, POST } from './route';
import { POST as token } from '../token/route';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('the consent step of the authorization endpoint', () => {
  let origin: string;
  const runId = randomUUID();
  const clientId = `client_${runId.slice(0, 8)}`;
  const clientSecret = 'client-secret-for-tests';
  const subject = `person-${runId.slice(0, 8)}@example.com`;
  const someoneElse = `someone-else-${runId.slice(0, 8)}@example.com`;
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const redirectUri = 'http://127.0.0.1/callback';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = computeS256(verifier);

  function cookie(id: string = sessionId): string {
    return `renkei_session=${id}`;
  }

  function authorize(overrides: Record<string, string | null> = {}, session = sessionId) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:50321/callback',
      state: 'xyz',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    const request = new NextRequest(
      `http://localhost/api/mcp/oauth/authorize?${query.toString()}`,
      { headers: { cookie: cookie(session) } }
    );
    return GET(request);
  }

  function answer(
    requestId: string,
    decision: string,
    options: { session?: string; origin?: string | null } = {}
  ) {
    resetInboundLimits();
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookie(options.session ?? sessionId),
    };
    const from = options.origin === undefined ? origin : options.origin;
    if (from) headers.origin = from;
    const request = new NextRequest(`http://localhost/api/mcp/oauth/authorize`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ request: requestId, decision }).toString(),
    });
    return POST(request);
  }

  /** The consent request id the GET redirect carries. */
  function requestIdOf(response: Response): string {
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.pathname).toBe('/oauth/consent');
    const id = url.searchParams.get('request');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    return id!;
  }

  async function exchange(code: string, codeVerifier: string | undefined) {
    resetInboundLimits();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:50321/callback',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (codeVerifier !== undefined) body.set('code_verifier', codeVerifier);
    const request = new NextRequest(`http://localhost/api/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return token(request);
  }

  beforeAll(async () => {
    const originResult = await getOrigin(new NextRequest('http://localhost/x'));
    if (!originResult.ok) throw new Error('no origin');
    origin = originResult.val;
    const store = getDataStore();
    await store.oauthConsents.registerClient({
      clientId,
      clientSecretHash: hashToken(clientSecret),
      clientName: 'Test MCP client',
      redirectUris: [redirectUri],
      responseTypes: ['code'],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await store.sessions.create({ id: sessionId, subject, roles: ['renkei-user'], expiresAt });
    await store.sessions.create({
      id: otherSessionId,
      subject: someoneElse,
      roles: ['renkei-user'],
      expiresAt,
    });
  });

  afterAll(async () => {
    // Signing both people out ends their sessions and the tokens minted here.
    for (const person of [subject, someoneElse]) await getDataStore().sessions.revokeAll(person);
    await closeDataStore();
  });

  beforeEach(() => {
    resetInboundLimits();
  });

  it('turns away a request without an S256 challenge, on the registered redirect URI', async () => {
    const withoutS256: Array<Record<string, string | null>> = [
      { code_challenge: null, code_challenge_method: null },
      { code_challenge_method: 'plain' },
      { code_challenge: 'short' },
    ];
    for (const bad of withoutS256) {
      const response = await authorize(bad);
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin).toBe('http://127.0.0.1:50321');
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe('xyz');
      expect(location.searchParams.get('code')).toBeNull();
      // No consent request was recorded to answer later.
      expect(location.searchParams.get('request')).toBeNull();
    }
  });

  it('never redirects to a URI the client did not register, loopback port aside', async () => {
    const wrongHost = await authorize({ redirect_uri: 'http://attacker.example/callback' });
    expect(wrongHost.status).toBe(400);
    const wrongPath = await authorize({ redirect_uri: 'http://127.0.0.1:50321/other' });
    expect(wrongPath.status).toBe(400);
    const anyPort = await authorize({ redirect_uri: 'http://127.0.0.1:61000/callback' });
    expect(anyPort.status).toBe(303);
    expect(new URL(anyPort.headers.get('location')!).pathname).toBe('/oauth/consent');
  });

  it('records the request against the browser session and sends it to the consent page', async () => {
    const response = await authorize();
    expect(response.status).toBe(303);
    const requestId = requestIdOf(response);
    const row = await getDataStore().oauthConsents.getRequest(requestId);
    expect(row).toMatchObject({
      clientId,
      sessionId,
      subject,
      redirectUri: 'http://127.0.0.1:50321/callback',
      state: 'xyz',
      scope: 'openid',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      clientName: 'Test MCP client',
    });
    // The redirect goes to the consent page, carrying no code.
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('accepts an answer only from the session that was shown the page, posted from this origin', async () => {
    const requestId = requestIdOf(await authorize());

    const crossSite = await answer(requestId, 'allow', { origin: 'https://attacker.example' });
    expect(crossSite.status).toBe(403);
    const noOrigin = await answer(requestId, 'allow', { origin: null });
    expect(noOrigin.status).toBe(403);
    // Refused before the database: the request is still pending for its own session.
    expect(await getDataStore().oauthConsents.getRequest(requestId)).not.toBeNull();

    const otherSession = await answer(requestId, 'allow', { session: otherSessionId });
    expect(otherSession.status).toBe(403);
    // Another session's answer is refused AND spends the row: the request
    // was shown to one browser, and whatever happens to it next, no code
    // comes out of it. A replay by the right session finds nothing.
    const replay = await answer(requestId, 'allow');
    expect(replay.status).toBe(400);
    expect(await getDataStore().oauthConsents.getRequest(requestId)).toBeNull();
  });

  it('sends access_denied when the person declines, and spends the request', async () => {
    const requestId = requestIdOf(await authorize());
    const denied = await answer(requestId, 'deny');
    expect(denied.status).toBe(303);
    const location = new URL(denied.headers.get('location')!);
    expect(location.origin).toBe('http://127.0.0.1:50321');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('xyz');
    const again = await answer(requestId, 'deny');
    expect(again.status).toBe(400);
    const audit = (await getDataStore().auditEvents.listRecent(500)).filter(
      (event) => event.actorSubject === subject
    );
    expect(audit.map((event) => event.action)).toEqual(['oauth.consent_denied']);
  });

  it('mints a code on Allow that only the committed verifier can exchange', async () => {
    const requestId = requestIdOf(await authorize());
    const allowed = await answer(requestId, 'allow');
    expect(allowed.status).toBe(303);
    const location = new URL(allowed.headers.get('location')!);
    expect(location.origin).toBe('http://127.0.0.1:50321');
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code');
    expect(code).toMatch(/^code_/);

    const row = await getDataStore().oauthConsents.getAuthorizationCode(code!);
    expect(row).toMatchObject({ subject, clientId, codeChallengeMethod: 'S256' });
    expect(row?.roles).toEqual(['renkei-user']);

    const missing = await exchange(code!, undefined);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid_request' });

    const granted = await exchange(code!, verifier);
    expect(granted.status).toBe(200);
    const tokens = await granted.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    // One-time use: the same code again is gone.
    const reused = await exchange(code!, verifier);
    expect(reused.status).toBe(400);
  });

  it('burns the code when the wrong verifier is presented', async () => {
    const requestId = requestIdOf(await authorize());
    const allowed = await answer(requestId, 'allow');
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;

    const wrong = await exchange(code, randomBytes(32).toString('base64url'));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
    const right = await exchange(code, verifier);
    expect(right.status).toBe(400);
  });

  it('bounces a browser without a session through sign-in', async () => {
    const response = await authorize({}, randomUUID());
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/api/auth/oidc/login');
  });
});
