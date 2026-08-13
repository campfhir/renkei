/**
 * Start a Zoom user-grant flow: "let Renkei see my meetings as me."
 * Mirrors the WebEx flow — signed-in caller, single-use state carrying the
 * subject, provider recorded so the shared callback knows whose token
 * endpoint to visit.
 *
 * Zoom scope mechanics: GRANULAR-scope Marketplace apps (every newly
 * created app) honor the "advanced authorization query" — a `scope`
 * parameter listing the granular scopes this authorization must mint.
 * Without it, consent covers only the app's default required set, which
 * once minted a token that could not even call /users/me. So the narrowed
 * selection is sent explicitly; every scope must also exist on the
 * Marketplace app (the ceiling mirrors it). The same selection is recorded
 * on the pending row → requested_scopes, and tool registration gates on
 * it — Renkei's own enforcement stays even where Zoom's is coarse.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getZoomApp, ZOOM_CONNECTOR } from '@/lib/zoom-app';
import { ZOOM_REQUIRED_SCOPES } from '@/lib/zoom-scopes';
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
      { error: 'Not signed in', error_description: 'Sign in before connecting Zoom' },
      { status: 401 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getZoomApp(tenantId, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Zoom integration not configured for this organization' },
      { status: 503 }
    );
  }

  // The user may narrow the org's scope ceiling, never widen it — enforced
  // here, not in the picker. The selection is both sent to Zoom (the
  // advanced authorization query narrows the minted token) and recorded as
  // requested_scopes for the tool-registration gate.
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
      ...ZOOM_REQUIRED_SCOPES.filter((scope) => !requested.includes(scope)),
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
      provider: ZOOM_CONNECTOR,
      scopes: effectiveScopes,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  // Advanced authorization query — see the header comment. Space-delimited
  // per OAuth convention (Zoom's own token response echoes scopes the same
  // way); URLSearchParams encodes the spaces.
  const authUrl = new URL('https://zoom.us/oauth/authorize');
  authUrl.searchParams.append('client_id', app.clientId);
  authUrl.searchParams.append('redirect_uri', app.redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', effectiveScopes);
  authUrl.searchParams.append('state', state);

  return NextResponse.redirect(authUrl.toString());
}
