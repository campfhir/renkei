import React from 'react';
import { getDatabase } from '@renkei/db';
import { redirect } from 'next/navigation';
import { getOrigin } from '@/lib/get-origin';
import { oidcDiscoveryUrl } from '@/lib/oidc-discovery';
import { randomUUID } from 'crypto';

const SIGN_IN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function isDiscoveryResponse(data: unknown): data is { authorization_endpoint: string } {
  if (typeof data !== 'object' || data === null) return false;
  if (!('authorization_endpoint' in data)) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return typeof obj.authorization_endpoint === 'string';
}

export default async function SignInPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div style={{ padding: '2rem', maxWidth: '500px' }}>
        <h2>Error</h2>
        <p>Unable to connect to the database. Please try again later.</p>
      </div>
    );
  }
  const db = dbResult.val;
  // The deployment's public origin: the stored platform setting, or the
  // localhost fallback before one is configured.
  const originResult = await getOrigin();
  const origin = originResult.ok ? originResult.val : 'http://localhost:3000';

  // Fetch tenant and OIDC config
  const tenant = await db
    .selectFrom('tenants')
    .select(['id'])
    .where('slug', '=', slug)
    .executeTakeFirst();

  if (!tenant) {
    redirect(`/${slug}/admin`);
  }

  const oidcConfig = await db
    .selectFrom('tenant_oidc')
    .selectAll()
    .where('tenant_id', '=', tenant.id)
    .executeTakeFirst();

  if (!oidcConfig) {
    redirect(`/${slug}/admin`);
  }

  // Fetch OIDC discovery to get authorization endpoint
  let authorizationEndpoint: string;
  try {
    const discoveryUrl = oidcDiscoveryUrl(oidcConfig.issuer);
    const discoveryResponse = await fetch(discoveryUrl);
    const discovery = await discoveryResponse.json();
    if (isDiscoveryResponse(discovery)) {
      authorizationEndpoint = discovery.authorization_endpoint;
    } else {
      authorizationEndpoint = oidcConfig.issuer;
    }
  } catch (err) {
    console.error('Failed to fetch OIDC discovery:', err);
    // Fallback to issuer
    authorizationEndpoint = oidcConfig.issuer;
  }

  // Generate OIDC authorization request
  const state = randomUUID();
  const redirectUri = `${origin}/api/auth/oidc/callback`;
  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + SIGN_IN_TTL_MS).toISOString();

  // Store pending sign-in for verification (CSRF protection)
  try {
    await db
      .insertInto('pending_oidc_signin')
      .values({
        state,
        nonce,
        tenant_id: tenant.id,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        id: randomUUID(),
      })
      .execute();
  } catch (err) {
    console.error('Failed to store sign-in state:', err);
    // Continue anyway - redirect will still work, just without CSRF protection
  }

  // Build authorization URL
  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.append('client_id', oidcConfig.client_id);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', 'openid email profile');
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('nonce', nonce);

  redirect(authUrl.toString());
}
