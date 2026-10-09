import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getDatabase } from '@renkei/db';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest, type Session } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { codeChallengeProblem } from '@/lib/oauth-pkce';
import { describeRedirectTarget, redirectUriMatches } from '@/lib/oauth-redirect-uri';
import { recordAuditEvent } from '@/lib/audit-events';

/**
 * Tenant-scoped OAuth 2.0 authorization endpoint (RFC 6749 section 3.1),
 * in two steps.
 *
 * GET validates the request — a registered client, one of its redirect
 * URIs, an S256 PKCE challenge, a signed-in browser — and then, instead of
 * minting the code, records the request against THIS browser session and
 * sends the person to the consent page, which names the client and where
 * its code would go.
 *
 * POST is the consent page's answer. Only the session the request was
 * recorded for may give it, the form must have been submitted from this
 * origin, and the request row is spent either way: allow mints the code
 * and redirects to the client, deny redirects with `access_denied`.
 *
 * Without the second step a signed-in person who clicked a crafted link
 * (any registered client_id, its redirect URI) handed that client a code,
 * and so a token acting as them, with nothing on screen.
 */

/** How long the consent page may sit open before the request has to start again. */
export const CONSENT_REQUEST_TTL_MS = 10 * 60_000;

/**
 * A person answers one consent page at a time; a burst of POSTs from one
 * address is a script guessing request ids, refused before the database.
 */
const POST_LIMITS = {
  perClient: { limit: 30, windowMs: 60_000 },
  global: { limit: 600, windowMs: 60_000 },
};

function oauthError(status: number, error: string, description: string): NextResponse {
  return NextResponse.json({ error, error_description: description }, { status });
}

/** An error the client can act on, delivered the way RFC 6749 4.1.2.1 says: on its own redirect URI. */
function redirectWithError(
  redirectUri: string,
  state: string,
  error: string,
  description: string
): NextResponse {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  url.searchParams.set('state', state);
  return NextResponse.redirect(url.toString(), 303);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    const searchParams = request.nextUrl.searchParams;
    const responseType = searchParams.get('response_type');
    const clientId = searchParams.get('client_id');
    const redirectUri = searchParams.get('redirect_uri');
    const state = searchParams.get('state');
    const scope = searchParams.get('scope');
    const codeChallenge = searchParams.get('code_challenge');
    const codeChallengeMethod = searchParams.get('code_challenge_method');

    if (!responseType || !clientId || !redirectUri || !state) {
      return oauthError(
        400,
        'invalid_request',
        'Missing required parameters: response_type, client_id, redirect_uri, state'
      );
    }
    if (state.length > 2048) {
      return oauthError(400, 'invalid_request', 'state is too long');
    }

    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', clientId)
      .executeTakeFirst();
    if (!client) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }

    // Nothing is redirected anywhere until the redirect URI is known to be
    // the client's own: an error sent to an unverified URI is itself the
    // open redirect this flow exists to avoid.
    if (!redirectUriMatches(client.redirect_uris, redirectUri)) {
      return oauthError(400, 'invalid_request', 'redirect_uri is not registered for this client');
    }

    if (responseType !== 'code') {
      return redirectWithError(
        redirectUri,
        state,
        'unsupported_response_type',
        'Only "code" response_type is supported'
      );
    }

    const pkceProblem = codeChallengeProblem(codeChallenge, codeChallengeMethod);
    if (pkceProblem) {
      return redirectWithError(redirectUri, state, 'invalid_request', pkceProblem);
    }

    // The code this request leads to becomes a bearer token acting as a
    // specific person, so it has to be bound to a signed-in browser. This
    // is a redirect flow: bounce through login and come back here.
    const session = await getSessionFromRequest(request, tenantId);
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
    if (!session) {
      // request.nextUrl.origin is the internal address behind a reverse
      // proxy (e.g. localhost:3000), unreachable for the user's browser;
      // getOrigin resolves the public one.
      const loginUrl = new URL('/api/auth/oidc/login', originResult.val);
      loginUrl.searchParams.set('tenantId', tenantId);
      loginUrl.searchParams.set('redirect', `${request.nextUrl.pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(loginUrl);
    }

    // Abandoned consent pages leave rows behind; sweep this tenant's on the
    // way past rather than carrying a scheduled job for a few bytes.
    await db
      .deleteFrom('oauth_consent_requests')
      .where('expires_at', '<', new Date())
      .execute();

    const requestId = randomUUID();
    await db
      .insertInto('oauth_consent_requests')
      .values({
        id: requestId,
        client_id: clientId,
        session_id: session.id,
        subject: session.subject,
        redirect_uri: redirectUri,
        state,
        scope: scope || 'openid profile email',
        code_challenge: codeChallenge!,
        code_challenge_method: codeChallengeMethod!,
        expires_at: new Date(Date.now() + CONSENT_REQUEST_TTL_MS),
      })
      .execute();

    const consentUrl = new URL('/oauth/consent', originResult.val);
    consentUrl.searchParams.set('request', requestId);
    return NextResponse.redirect(consentUrl, 303);
  } catch (error) {
    logger.error('Error: {detail}', {
      component: 'auth/oauth-authorize',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * Whether a form POST came from a page this server rendered. Browsers send
 * `Origin` on every cross-site POST and on same-origin form posts too, so
 * a mismatch, or a missing header on a request that `Sec-Fetch-Site` does
 * not vouch for, is a page somewhere else submitting our form.
 */
export function submittedFromThisOrigin(request: NextRequest, ourOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (origin) return origin === ourOrigin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {

  const verdict = checkInboundLimit(`oauth/consent:${tenantId}`, request, POST_LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'slow_down', error_description: 'Too many consent answers' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  if (!submittedFromThisOrigin(request, originResult.val)) {
    return oauthError(403, 'invalid_request', 'The consent form must be submitted from this site');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError(400, 'invalid_request', 'Expected a form submission');
  }
  const requestId = form.get('request');
  const decision = form.get('decision');
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    return oauthError(400, 'invalid_request', 'request is required');
  }
  if (decision !== 'allow' && decision !== 'deny') {
    return oauthError(400, 'invalid_request', 'decision must be allow or deny');
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const session = await getSessionFromRequest(request, tenantId);
    if (!session) {
      return oauthError(401, 'invalid_request', 'Sign in before answering a consent request');
    }

    // Spent on the first answer, whatever it is: a second POST with the same
    // id — a double click, a replay — finds nothing.
    const pending = await db
      .deleteFrom('oauth_consent_requests')
      .where('id', '=', requestId)
      .returningAll()
      .executeTakeFirst();
    if (!pending || pending.expires_at < new Date()) {
      return oauthError(
        400,
        'invalid_request',
        'This authorization request has expired or was already answered; start again from the application'
      );
    }

    // The binding that makes the page mean something: the browser that was
    // shown the client's name is the only one whose answer counts.
    if (pending.session_id !== session.id || pending.subject !== session.subject) {
      return oauthError(403, 'invalid_request', 'This request belongs to another session');
    }

    const redirectTarget = describeRedirectTarget(pending.redirect_uri);

    if (decision === 'deny') {
      recordAuditEvent({
        actorSubject: session.subject,
        action: 'oauth.consent_denied',
        targetKind: 'oauth_client',
        targetLabel: pending.client_id,
        details: { clientId: pending.client_id, redirectTarget },
      });
      return redirectWithError(
        pending.redirect_uri,
        pending.state,
        'access_denied',
        'The person declined to authorize this application'
      );
    }

    const code = await mintAuthorizationCode(db, tenantId, pending, session);
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'oauth.consent_granted',
      targetKind: 'oauth_client',
      targetLabel: pending.client_id,
      details: { clientId: pending.client_id, redirectTarget, scope: pending.scope },
    });

    const callbackUrl = new URL(pending.redirect_uri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', pending.state);
    return NextResponse.redirect(callbackUrl.toString(), 303);
  } catch (error) {
    logger.error('Consent error: {detail}', {
      component: 'auth/oauth-authorize',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/**
 * The authorization code itself. Roles ride along from the browser session
 * that authorized it — captured once, here, rather than re-queried from
 * the IdP on every MCP call: the browser session already holds what the
 * IdP asserted at sign-in (see lib/session.ts), and this is the one point
 * where that session and the MCP token this code becomes are both in hand.
 * A stale role (the IdP's claim changed since sign-in) clears the same way
 * the browser session's does — the caller re-authenticates through this
 * same flow to pick it up.
 */
async function mintAuthorizationCode(
  db: Kysely<DB>,
  tenantId: string,
  pending: {
    client_id: string;
    redirect_uri: string;
    scope: string | null;
    code_challenge: string;
    code_challenge_method: string;
  },
  session: Session
): Promise<string> {
  const code = `code_${randomUUID()}`;
  const settingsResult = await getOrgSettings(tenantId);
  const settings = settingsResult.ok ? settingsResult.val : DEFAULT_ORG_SETTINGS;
  const expiresAt = new Date(Date.now() + settings.authorizationCodeTtlSeconds * 1000);

  await db
    .insertInto('oauth_authorization_codes')
    .values({
      code,
      client_id: pending.client_id,
      subject: session.subject,
      scope: pending.scope || 'openid profile email',
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      code_challenge_method: pending.code_challenge_method,
      roles: session.roles,
      expires_at: expiresAt,
    })
    .execute();
  return code;
}
