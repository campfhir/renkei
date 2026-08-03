import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

export async function GET(request: NextRequest) {
  const config = getConfig();
  const db = getDatabase();

  const client_id = config.ATLASSIAN_CLIENT_ID;
  const redirect_uri = config.ATLASSIAN_REDIRECT_URI;
  const scope = config.ATLASSIAN_SCOPES;
  const response_type = 'code';
  const audience = 'api.atlassian.com';
  const state = randomUUID();
  const nonce = randomUUID();

  // Store state in database for CSRF validation on callback
  // For MVP, we use ATLASSIAN_CLOUD_ID as the tenant ID since it's environment-specific
  const tenantId = config.ATLASSIAN_CLOUD_ID || randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  try {
    // Ensure tenant exists (create if needed for MVP)
    const existingTenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!existingTenant) {
      await db
        .insertInto('tenants')
        .values({
          id: tenantId,
          slug: 'default',
          created_at: new Date().toISOString(),
        })
        .execute();
    }

    // Store state for CSRF validation
    await db
      .insertInto('pending_oidc_signin')
      .values({
        id: randomUUID(),
        state,
        nonce,
        tenant_id: tenantId,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();
  } catch (err) {
    console.error('Failed to store OIDC state:', err);
    return NextResponse.json({ error: 'Failed to initiate OAuth flow' }, { status: 500 });
  }

  const authUrl = new URL('https://auth.atlassian.com/authorize');
  authUrl.searchParams.append('audience', audience);
  authUrl.searchParams.append('client_id', client_id);
  authUrl.searchParams.append('redirect_uri', redirect_uri);
  authUrl.searchParams.append('response_type', response_type);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('state', state);

  console.log('[OAuth Authorize] Sending to Atlassian:');
  console.log('  audience:', audience);
  console.log('  client_id:', client_id);
  console.log('  redirect_uri:', redirect_uri);
  console.log('  response_type:', response_type);
  console.log('  state:', state);
  console.log('  scope (first 100 chars):', scope.substring(0, 100) + '...');
  console.log('  Full URL:', authUrl.toString());

  return NextResponse.redirect(authUrl.toString());
}
