/**
 * Start a WebEx user-grant flow: "let Renkei read my WebEx as me."
 * Mirrors the Jira flow at /api/mcp/[tenantId]/authorize — signed-in caller,
 * single-use state carrying the subject, provider recorded so the shared
 * callback knows whose token endpoint to visit.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getWebexUserApp, WEBEX_USER_CONNECTOR } from '@/lib/webex-app';
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

  const tenant = await db
    .selectFrom('tenants')
    .select('id')
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (!tenant) {
    return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  }

  // The resulting grant is bound to whoever completes this flow, so the
  // caller must already be signed in.
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json(
      { error: 'Not signed in', error_description: 'Sign in before connecting WebEx' },
      { status: 401 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getWebexUserApp(tenantId, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'WebEx user integration not configured for this organization' },
      { status: 503 }
    );
  }

  const state = randomUUID();
  await db
    .insertInto('pending_oidc_signin')
    .values({
      id: randomUUID(),
      state,
      nonce: randomUUID(),
      tenant_id: tenantId,
      subject: session.subject,
      provider: WEBEX_USER_CONNECTOR,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const authUrl = new URL('https://webexapis.com/v1/authorize');
  authUrl.searchParams.append('client_id', app.clientId);
  authUrl.searchParams.append('redirect_uri', app.redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', app.scopes);
  authUrl.searchParams.append('state', state);

  return NextResponse.redirect(authUrl.toString());
}
