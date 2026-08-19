import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getDatabase } from '@renkei/db';
import { getTenantOidc } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';
import { sessionCookieName } from '@/lib/session';
import { oidcDiscoveryUrl } from '@/lib/oidc-discovery';
import { safeFetch } from '@/lib/safe-fetch';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get('tenantId');
  // Empty means "no preference": the callback then derives the tenant's home
  // page from its slug rather than this route hardcoding a landing.
  const redirect = searchParams.get('redirect') || '';

  if (!tenantId) {
    return NextResponse.json({ error: 'Missing tenantId' }, { status: 400 });
  }

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      // A browser gets here by following the proxy's redirect, so answering
      // with JSON leaves it stranded. The tenant being gone while the browser
      // still holds a session cookie for it is the loop this clears: the cookie
      // makes the proxy report "signed in", every page then fails to resolve a
      // session, and the only route back to authentication is this one.
      const home = new URL('/', request.url);
      home.searchParams.set('error', 'tenant_not_found');
      const stranded = NextResponse.redirect(home);
      stranded.cookies.delete(sessionCookieName(tenantId));
      return stranded;
    }

    // Get OIDC config
    const oidcResult = await getTenantOidc(tenantId);
    if (!oidcResult.ok) {
      return NextResponse.json({ error: 'Failed to retrieve OIDC configuration' }, { status: 500 });
    }
    const oidc = oidcResult.val;
    if (!oidc) {
      return NextResponse.json({ error: 'OIDC not configured for this tenant' }, { status: 400 });
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
        tenant_id: tenantId,
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
    response.cookies.delete(sessionCookieName(tenantId));

    response.cookies.set(`oidc_redirect_${tenantId}`, redirect, {
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
    response.cookies.set(`oidc_state_${tenantId}`, state, {
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
