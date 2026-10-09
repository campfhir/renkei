import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getDatabase } from '@renkei/db';
import { getTenantOidc } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';
import { sessionCookieName } from '@/lib/session';
import { safeReturnPath } from '@/lib/return-path';
import { oidcDiscoveryUrl } from '@/lib/oidc-discovery';
import { safeFetch } from '@/lib/safe-fetch';
import { randomUUID } from 'crypto';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';

/**
 * Every call writes a pending_oidc_signin row and fetches the IdP's
 * discovery document, with no session to gate on — it is the thing that
 * creates sessions. A person signs in a few times a day; a browser stuck
 * in a redirect loop is the legitimate worst case, and thirty a minute
 * leaves room for it while refusing a flood of row inserts.
 */
const LIMITS = {
  perClient: { limit: 30, windowMs: 60_000 },
  global: { limit: 600, windowMs: 60_000 },
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  // Empty means "no preference": the callback then lands on the home page
  // rather than this route hardcoding a landing. Only a
  // path on this origin is kept — anyone can author this query string, and
  // the callback would otherwise send a fresh session wherever it said.
  const redirect = safeReturnPath(searchParams.get('redirect')) ?? '';

  const verdict = checkInboundLimit('oidc/login', request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'Too many sign-in attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Get OIDC config
    const oidcResult = await getTenantOidc();
    if (!oidcResult.ok) {
      return NextResponse.json({ error: 'Failed to retrieve OIDC configuration' }, { status: 500 });
    }
    const oidc = oidcResult.val;
    if (!oidc) {
      // Nobody can sign in until the identity provider exists; the setup
      // page is where it is created. A browser arriving here from the
      // signed-out redirect would otherwise land on a JSON error.
      const originForSetup = await getOrigin(request);
      const base = originForSetup.ok ? originForSetup.val : request.nextUrl.origin;
      return NextResponse.redirect(new URL('/setup', base));
    }

    // Generate state (CSRF) and nonce (id_token replay). The nonce is sent to
    // the IdP and echoed back in the id_token, where the callback verifies it.
    const state = randomUUID();
    const nonce = randomUUID();
    const stateExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store pending OIDC state
    await db
      .insertInto('pending_oidc_signin')
      .values({
        id: randomUUID(),
        state,
        nonce,
        expires_at: stateExpiresAt.toISOString(),
      })
      .execute();

    // Fetch OIDC discovery document to get the authorization endpoint
    const discoveryUrl = oidcDiscoveryUrl(oidc.issuer);
    let authorizationEndpoint: string;

    console.log(`[OIDC] Fetching discovery from: ${discoveryUrl}`);

    try {
      // SSRF-guarded: the issuer is operator-configured, but the fetch is still
      // constrained to a public https target so a stale or hostile issuer can't
      // drive a server-side request at an internal address.
      const discoveryResponse = await safeFetch(discoveryUrl);
      if (discoveryResponse.ok) {
        const discovery = await discoveryResponse.json();
        authorizationEndpoint = discovery.authorization_endpoint;
        console.log(`[OIDC] Discovery successful, using endpoint: ${authorizationEndpoint}`);
      } else {
        console.log(
          `[OIDC] Discovery failed with status ${discoveryResponse.status}, using Azure AD fallback`
        );
        // For Azure AD specifically, use the OAuth2 v2.0 endpoint
        // Strip trailing /v2.0 from issuer if present to avoid duplication
        const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
        authorizationEndpoint = `${baseIssuer}/oauth2/v2.0/authorize`;
      }
    } catch (error) {
      logger.error('Failed to fetch discovery document: {detail}', {
        component: 'auth/oidc',
        detail: error instanceof Error ? error.message : String(error),
      });
      // Fallback to Azure AD OAuth2 v2.0 endpoint
      // Strip trailing /v2.0 from issuer if present to avoid duplication
      const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
      authorizationEndpoint = `${baseIssuer}/oauth2/v2.0/authorize`;
    }

    // Build OIDC authorization URL
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const origin = originResult.val;
    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set('client_id', oidc.clientId);
    authUrl.searchParams.set('redirect_uri', `${origin}/api/auth/oidc/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);

    // Store redirect target in session (via cookie)
    const response = NextResponse.redirect(authUrl);

    // Drop whatever session cookie the browser arrived with. The proxy can only
    // check that one is present — it runs before the database is reachable — so
    // a cookie whose session has expired or been revoked leaves every protected
    // route allowed but unauthenticated, with no path back here. The callback
    // issues a fresh cookie; abandoning the flow now leaves the browser plainly
    // signed out instead of stuck.
    response.cookies.delete(sessionCookieName());

    response.cookies.set('oidc_redirect', redirect, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60, // 10 minutes
    });

    // Bind the flow to THIS browser. The callback requires this cookie to match
    // the state it receives, so a state+code pair captured by an attacker and
    // replayed into a victim's browser (login CSRF / session fixation) fails:
    // the victim's browser never carries the attacker's state cookie. sameSite
    // 'lax' still sends it on the top-level redirect back from the IdP.
    response.cookies.set('oidc_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60, // 10 minutes
    });

    return response;
  } catch (error) {
    console.error('OIDC login error:', error);
    return NextResponse.json({ error: 'Authentication setup failed' }, { status: 500 });
  }
}
