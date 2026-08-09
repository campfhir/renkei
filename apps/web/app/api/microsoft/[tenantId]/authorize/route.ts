/**
 * Start a Microsoft user-grant flow: "let Renkei read my Outlook as me."
 * Mirrors the WebEx flow — signed-in caller, single-use state carrying the
 * subject, provider recorded so the shared callback knows whose token
 * endpoint to visit. The authority is the org's own Entra directory, never
 * `common`: single-org deployment, org accounts only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getMicrosoftApp, MICROSOFT_CONNECTOR } from '@/lib/microsoft-app';
import { MICROSOFT_REQUIRED_SCOPES } from '@/lib/microsoft-scopes';
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
      { error: 'Not signed in', error_description: 'Sign in before connecting Microsoft' },
      { status: 401 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getMicrosoftApp(tenantId, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Microsoft integration not configured for this organization' },
      { status: 503 }
    );
  }

  // The user may narrow the org's scope ceiling, never widen it — enforced
  // here, not in the picker. Required scopes always ride along: without the
  // identity claims the callback cannot tell who granted, and without
  // offline_access Microsoft mints no refresh token at all.
  const ceiling = new Set(app.scopes.split(/\s+/));
  const requestedParam = new URL(request.url).searchParams.get('scopes');
  let effectiveScopes = app.scopes;
  if (requestedParam) {
    const requested = requestedParam.split(/[\s,+]+/).filter(Boolean);
    const outside = requested.filter((scope) => !ceiling.has(scope));
    if (outside.length > 0) {
      return NextResponse.json(
        { error: `Scopes not allowed by this organization: ${outside.join(', ')}` },
        { status: 400 }
      );
    }
    effectiveScopes = [
      ...requested,
      ...MICROSOFT_REQUIRED_SCOPES.filter((scope) => !requested.includes(scope)),
    ].join(' ');
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
      provider: MICROSOFT_CONNECTOR,
      scopes: effectiveScopes,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const authUrl = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(app.directoryTenantId)}/oauth2/v2.0/authorize`
  );
  authUrl.searchParams.append('client_id', app.clientId);
  authUrl.searchParams.append('redirect_uri', app.redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('response_mode', 'query');
  authUrl.searchParams.append('scope', effectiveScopes);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('prompt', 'select_account');

  return NextResponse.redirect(authUrl.toString());
}
