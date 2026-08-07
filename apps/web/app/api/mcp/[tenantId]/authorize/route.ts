import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getAtlassianApp } from '@/lib/atlassian-app';
import { getOrigin } from '@/lib/get-origin';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
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

    // The resulting grant is bound to whoever completes this flow, so the caller
    // must already be signed in. Without this, anyone holding a tenantId could
    // attach their own Atlassian account to that tenant.
    const session = await getSessionFromRequest(request, tenantId);
    if (!session) {
      return NextResponse.json(
        { error: 'Not signed in', error_description: 'Sign in before connecting Jira' },
        { status: 401 }
      );
    }

    // The org's Atlassian app registration comes from connector config in
    // the database; without one, no Atlassian flow can start.
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const app = await getAtlassianApp(tenantId, originResult.val);
    if (!app) {
      return NextResponse.json(
        { error: 'Atlassian connector not configured for this organization' },
        { status: 503 }
      );
    }

    // Generate state for CSRF protection
    const state = randomUUID();
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store pending OAuth state, carrying the connecting user so the callback
    // knows whose grant to stamp.
    await db
      .insertInto('pending_oidc_signin')
      .values({
        id: randomUUID(),
        state,
        nonce,
        tenant_id: tenantId,
        subject: session.subject,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();

    // Build Atlassian OAuth URL for this tenant
    const authUrl = new URL('https://auth.atlassian.com/authorize');
    authUrl.searchParams.append('audience', 'api.atlassian.com');
    authUrl.searchParams.append('client_id', app.clientId);
    authUrl.searchParams.append('redirect_uri', app.redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', app.scopes);
    authUrl.searchParams.append('state', state);

    console.log(`[MCP ${tenantId}] Jira OAuth authorize:`);
    console.log('  client_id:', app.clientId);
    console.log('  redirect_uri:', app.redirectUri);
    console.log('  state:', state);

    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    console.error('MCP authorize error:', error);
    return NextResponse.json({ error: 'Failed to initiate authorization' }, { status: 500 });
  }
}
