import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getTenantOidc } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get('tenantId');
  const redirect = searchParams.get('redirect') || '/mcp';

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
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Get OIDC config
    const oidcResult = await getTenantOidc(tenantId);
    if (!oidcResult.ok) {
      return NextResponse.json(
        { error: 'Failed to retrieve OIDC configuration' },
        { status: 500 }
      );
    }
    const oidc = oidcResult.val;
    if (!oidc) {
      return NextResponse.json(
        { error: 'OIDC not configured for this tenant' },
        { status: 400 }
      );
    }

    // Generate state for CSRF protection
    const state = randomUUID();
    const stateExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store pending OIDC state
    await db
      .insertInto('pending_oidc_signin')
      .values({
        id: randomUUID(),
        state,
        tenant_id: tenantId,
        nonce: randomUUID(),
        expires_at: stateExpiresAt.toISOString(),
      })
      .execute();

    // Fetch OIDC discovery document to get the authorization endpoint
    const discoveryUrl = new URL('/.well-known/openid-configuration', oidc.issuer).toString();
    let authorizationEndpoint: string;

    console.log(`[OIDC] Fetching discovery from: ${discoveryUrl}`);

    try {
      const discoveryResponse = await fetch(discoveryUrl);
      if (discoveryResponse.ok) {
        const discovery = await discoveryResponse.json();
        authorizationEndpoint = discovery.authorization_endpoint;
        console.log(`[OIDC] Discovery successful, using endpoint: ${authorizationEndpoint}`);
      } else {
        console.log(`[OIDC] Discovery failed with status ${discoveryResponse.status}, using Azure AD fallback`);
        // For Azure AD specifically, use the OAuth2 v2.0 endpoint
        // Strip trailing /v2.0 from issuer if present to avoid duplication
        const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
        authorizationEndpoint = `${baseIssuer}/oauth2/v2.0/authorize`;
      }
    } catch (error) {
      console.error('[OIDC] Failed to fetch discovery document:', error);
      // Fallback to Azure AD OAuth2 v2.0 endpoint
      // Strip trailing /v2.0 from issuer if present to avoid duplication
      const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
      authorizationEndpoint = `${baseIssuer}/oauth2/v2.0/authorize`;
    }

    // Build OIDC authorization URL
    const originResult = getOrigin(request);
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

    // Store redirect target in session (via cookie)
    const response = NextResponse.redirect(authUrl);
    response.cookies.set(`oidc_redirect_${tenantId}`, redirect, {
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
