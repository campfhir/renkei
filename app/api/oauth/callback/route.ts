import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { setOperatorCookie, OperatorSession } from '@/lib/auth-utils';
import { randomUUID } from 'crypto';

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
 * Decode JWT without verification (for demo purposes).
 * In production, verify signature using JWKS from OIDC provider.
 */
function decodeJwt(token: string): OidcIdToken | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
    return JSON.parse(payload) as OidcIdToken;
  } catch {
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
    // TODO: Verify state matches a pending sign-in stored in database
    // For now, accept any state. In production:
    // 1. Query pending_oidc_signin table for this state
    // 2. Verify state is fresh (not expired)
    // 3. Extract tenant_id from pending record
    // 4. Get OIDC config for that tenant

    // For MVP, extract tenant from URL or header
    // This should come from stored pending state
    const tenantSlug = 'test'; // TODO: Get from pending state

    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'slug'])
      .where('slug', '=', tenantSlug)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    // Get OIDC config
    const oidcConfig = await db
      .selectFrom('tenant_oidc')
      .select(['issuer', 'client_id', 'client_secret', 'token_endpoint'])
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
    const idTokenClaims = decodeJwt(tokenData.id_token);

    if (!idTokenClaims) {
      return NextResponse.json({ error: 'Invalid ID token' }, { status: 400 });
    }

    // TODO: Verify ID token signature using tenant's OIDC JWKS
    // For MVP, we trust the token from the OIDC provider

    // TODO: Verify audience matches this application
    // For MVP, skip this check

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
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000; // 4 hours

    const session: OperatorSession = {
      sessionId,
      subject: idTokenClaims.sub,
      operator: displayName,
      tenantId: tenant.id,
      issuedAt: Date.now(),
      expiresAt,
    };

    // TODO: Store session in database (operator_sessions table)
    // For MVP, rely on cookie storage only

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

