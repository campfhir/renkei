import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { setOperatorCookie, OperatorSession } from '@/lib/auth-utils';
import { randomUUID } from 'crypto';
import { jwtVerify, importJWKS } from 'jose';

interface OidcTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
}

// Simplified ID token interface (JWT payload)
interface OidcIdToken {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  iat: number;
  exp: number;
  aud: string | string[];
  iss: string;
}

/**
 * Verify JWT signature using OIDC provider's JWKS
 */
async function verifyIdToken(
  token: string,
  issuer: string,
  audience: string,
  jwksUri: string
): Promise<OidcIdToken | null> {
  try {
    const jwksResponse = await fetch(jwksUri);
    if (!jwksResponse.ok) {
      console.error('Failed to fetch JWKS:', jwksResponse.statusText);
      return null;
    }

    const jwks = await jwksResponse.json();
    const key = await importJWKS(jwks);

    const verified = await jwtVerify(token, key, {
      issuer,
      audience,
      clockTolerance: 30,
    });

    return verified.payload as unknown as OidcIdToken;
  } catch (err) {
    console.error('ID token verification failed:', err);
    return null;
  }
}

/**
 * Extract human-readable name from ID token claims
 */
function extractDisplayName(claims: OidcIdToken): string {
  if (claims.name) return claims.name;
  if (claims.email) return claims.email.split('@')[0];
  if (claims.given_name || claims.family_name) {
    return `${claims.given_name || ''} ${claims.family_name || ''}`.trim();
  }
  return claims.sub.substring(0, 12);
}

export async function GET(request: NextRequest) {
  const config = getConfig();
  const db = getDatabase();
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  // Handle OIDC error response
  if (error) {
    return NextResponse.json(
      { error, error_description: errorDescription || 'Unknown error' },
      { status: 400 }
    );
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  try {
    // Verify state matches a pending sign-in stored in database (CSRF protection)
    const pendingSignIn = await db
      .selectFrom('pending_oidc_signin')
      .select(['tenant_id', 'nonce', 'expires_at'])
      .where('state', '=', state)
      .executeTakeFirst();

    if (!pendingSignIn) {
      return NextResponse.json(
        { error: 'Invalid or expired state' },
        { status: 400 }
      );
    }

    // Verify state is not expired
    const expiresAt = new Date(pendingSignIn.expires_at);
    if (expiresAt < new Date()) {
      // Clean up expired state
      try {
        await db
          .deleteFrom('pending_oidc_signin')
          .where('state', '=', state)
          .execute();
      } catch (err) {
        console.error('Failed to clean up expired state:', err);
      }

      return NextResponse.json(
        { error: 'State expired' },
        { status: 400 }
      );
    }

    // Get tenant info
    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'slug'])
      .where('id', '=', pendingSignIn.tenant_id)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    // Get OIDC config
    const oidcConfig = await db
      .selectFrom('tenant_oidc')
      .select(['issuer', 'client_id', 'client_secret', 'token_endpoint', 'jwks_uri'])
      .where('tenant_id', '=', tenant.id)
      .executeTakeFirst();

    if (!oidcConfig) {
      return NextResponse.json(
        { error: 'OIDC not configured for this tenant' },
        { status: 400 }
      );
    }

    // Exchange code for tokens with OIDC provider
    const tokenResponse = await fetch(oidcConfig.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: oidcConfig.client_id,
        client_secret: oidcConfig.client_secret,
        redirect_uri: `${config.PUBLIC_BASE_URL}/api/oauth/callback`,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', errorText);
      return NextResponse.json({ error: 'Token exchange failed' }, { status: 400 });
    }

    const tokenData = (await tokenResponse.json()) as OidcTokenResponse;

    if (!oidcConfig.jwks_uri) {
      return NextResponse.json(
        { error: 'OIDC JWKS URI not configured' },
        { status: 400 }
      );
    }

    // Verify ID token signature and audience
    const idTokenClaims = await verifyIdToken(
      tokenData.id_token,
      oidcConfig.issuer,
      oidcConfig.client_id,
      oidcConfig.jwks_uri
    );

    if (!idTokenClaims) {
      return NextResponse.json({ error: 'Invalid ID token' }, { status: 400 });
    }

    // Verify token not expired
    const now = Math.floor(Date.now() / 1000);
    if (idTokenClaims.exp < now) {
      return NextResponse.json({ error: 'Token expired' }, { status: 400 });
    }

    // TODO: Check if required role claim is present
    // For MVP, accept any authenticated user

    // Create operator session
    const sessionId = randomUUID();
    const displayName = extractDisplayName(idTokenClaims);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 4 * 60 * 60 * 1000; // 4 hours

    const session: OperatorSession = {
      sessionId,
      subject: idTokenClaims.sub,
      operator: displayName,
      tenantId: tenant.id,
      issuedAt,
      expiresAt,
    };

    // Store session in database
    try {
      await db
        .insertInto('operator_sessions')
        .values({
          session_id: sessionId,
          tenant_id: tenant.id,
          subject: idTokenClaims.sub,
          operator_name: displayName,
          issued_at: new Date(issuedAt).toISOString(),
          expires_at: new Date(expiresAt).toISOString(),
          created_at: new Date().toISOString(),
        })
        .execute();
    } catch (err) {
      console.error('Failed to store operator session:', err);
      // Continue anyway - cookie session will still work
    }

    // Clean up used state to prevent replay attacks
    try {
      await db
        .deleteFrom('pending_oidc_signin')
        .where('state', '=', state)
        .execute();
    } catch (err) {
      console.error('Failed to clean up state:', err);
      // Continue anyway - state is already expired
    }

    // Set session cookie
    const response = NextResponse.redirect(
      new URL(`/admin/${tenant.slug}`, request.url),
      { status: 302 }
    );

    await setOperatorCookie(session);

    return response;
  } catch (err) {
    console.error('OAuth callback error:', err);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}

