import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: "Config error" }, { status: 500 });
  }
  const config = configResult.val;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  const db = dbResult.val;

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

    // Generate state for CSRF protection
    const state = randomUUID();
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store pending OAuth state
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

    // Build Atlassian OAuth URL for this tenant
    const authUrl = new URL('https://auth.atlassian.com/authorize');
    authUrl.searchParams.append('audience', 'api.atlassian.com');
    authUrl.searchParams.append('client_id', config.ATLASSIAN_CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', config.ATLASSIAN_REDIRECT_URI);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', config.ATLASSIAN_SCOPES);
    authUrl.searchParams.append('state', state);

    console.log(`[MCP ${tenantId}] Jira OAuth authorize:`);
    console.log('  client_id:', config.ATLASSIAN_CLIENT_ID);
    console.log('  redirect_uri:', config.ATLASSIAN_REDIRECT_URI);
    console.log('  state:', state);

    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    console.error('MCP authorize error:', error);
    return NextResponse.json({ error: 'Failed to initiate authorization' }, { status: 500 });
  }
}
