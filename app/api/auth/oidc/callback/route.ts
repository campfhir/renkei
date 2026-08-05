import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getTenantOidc } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';

interface OIDCTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
}

interface DecodedToken {
  [key: string]: unknown;
}

function decodeJWT(token: string): DecodedToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const decoded = Buffer.from(parts[1], 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function isOIDCTokenResponse(data: unknown): data is OIDCTokenResponse {
  if (typeof data !== 'object' || data === null) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return typeof obj.access_token === 'string' && typeof obj.token_type === 'string' && typeof obj.expires_in === 'number';
}

export async function GET(request: NextRequest) {
  const db = getDatabase();
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.json(
      { error: `OIDC error: ${error}` },
      { status: 400 }
    );
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  try {
    // Look up pending OIDC state
    const pendingSignIn = await db
      .selectFrom('pending_oidc_signin')
      .select(['tenant_id', 'expires_at'])
      .where('state', '=', state)
      .executeTakeFirst();

    if (!pendingSignIn) {
      return NextResponse.json(
        { error: 'Invalid or expired state' },
        { status: 400 }
      );
    }

    // Verify state is not expired
    if (new Date(pendingSignIn.expires_at) < new Date()) {
      await db.deleteFrom('pending_oidc_signin').where('state', '=', state).execute();
      return NextResponse.json({ error: 'State expired' }, { status: 400 });
    }

    const tenantId = pendingSignIn.tenant_id;

    // Get OIDC config
    const oidc = await getTenantOidc(tenantId);
    if (!oidc) {
      return NextResponse.json(
        { error: 'OIDC not configured' },
        { status: 400 }
      );
    }

    // Fetch OIDC discovery document to get the token endpoint
    const discoveryUrl = new URL('/.well-known/openid-configuration', oidc.issuer).toString();
    let tokenEndpoint: string;

    console.log(`[OIDC] Fetching discovery from: ${discoveryUrl}`);

    try {
      const discoveryResponse = await fetch(discoveryUrl);
      if (discoveryResponse.ok) {
        const discovery = await discoveryResponse.json();
        tokenEndpoint = discovery.token_endpoint;
        console.log(`[OIDC] Discovery successful, using token endpoint: ${tokenEndpoint}`);
      } else {
        console.log(`[OIDC] Discovery failed with status ${discoveryResponse.status}, using Azure AD fallback`);
        // For Azure AD specifically, use the OAuth2 v2.0 endpoint
        // Strip trailing /v2.0 from issuer if present to avoid duplication
        const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
        tokenEndpoint = `${baseIssuer}/oauth2/v2.0/token`;
      }
    } catch (error) {
      console.error('[OIDC] Failed to fetch discovery document:', error);
      // Fallback to Azure AD OAuth2 v2.0 endpoint
      // Strip trailing /v2.0 from issuer if present to avoid duplication
      const baseIssuer = oidc.issuer.endsWith('/v2.0') ? oidc.issuer.slice(0, -5) : oidc.issuer;
      tokenEndpoint = `${baseIssuer}/oauth2/v2.0/token`;
    }

    // Exchange code for token
    const origin = getOrigin(request);
    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oidc.clientId,
        client_secret: oidc.clientSecret,
        code,
        redirect_uri: `${origin}/api/auth/oidc/callback`,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('OIDC token exchange failed:', errorText);
      return NextResponse.json(
        { error: 'Failed to exchange code for token' },
        { status: 400 }
      );
    }

    const tokenData = await tokenResponse.json();
    if (!isOIDCTokenResponse(tokenData)) {
      return NextResponse.json(
        { error: 'Invalid token response' },
        { status: 400 }
      );
    }

    // Decode and mint standardized renkei roles from IDP claims
    const userRoles = new Set<string>();
    if (tokenData.id_token) {
      const decoded = decodeJWT(tokenData.id_token);
      if (decoded && oidc.roleClaim) {
        const idpClaim = decoded[oidc.roleClaim];

        // Handle both single value string and array of values
        const idpValues = Array.isArray(idpClaim) ? idpClaim : (idpClaim ? [idpClaim] : []);

        for (const value of idpValues) {
          if (value === oidc.operatorIdpValue) {
            userRoles.add('renkei-operator');
          }
          if (value === oidc.userIdpValue) {
            userRoles.add('renkei-user');
          }
        }

        // Require user to have at least one renkei role
        if (userRoles.size === 0) {
          console.error(
            `[OIDC ${tenantId}] User has no authorized roles. IDP claim "${oidc.roleClaim}": ${JSON.stringify(idpClaim)}`
          );
          return NextResponse.json(
            { error: 'User role not authorized for this tenant' },
            { status: 403 }
          );
        }
      }
    }

    // Delete used state token
    await db.deleteFrom('pending_oidc_signin').where('state', '=', state).execute();

    // Get redirect target from cookie
    const redirectCookie = request.cookies.get(`oidc_redirect_${tenantId}`)?.value;
    const redirect = redirectCookie || `/mcp/${tenantId}`;

    // Set token cookie and redirect
    const response = NextResponse.redirect(new URL(redirect, origin));
    response.cookies.set(`oidc_token_${tenantId}`, tokenData.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: tokenData.expires_in || 3600, // Use token expiry
    });

    // Store user roles in a separate cookie (not httpOnly so client can read it)
    // Convert Set to comma-separated string for cookie storage
    if (userRoles.size > 0) {
      const rolesStr = Array.from(userRoles).join(',');
      response.cookies.set(`oidc_roles_${tenantId}`, rolesStr, {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: tokenData.expires_in || 3600,
      });
    }

    // Clear redirect cookie
    response.cookies.delete(`oidc_redirect_${tenantId}`);

    return response;
  } catch (error) {
    console.error('OIDC callback error:', error);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
