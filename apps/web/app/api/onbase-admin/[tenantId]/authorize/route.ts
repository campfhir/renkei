/**
 * Start an OnBase Administration user-grant flow: "let Renkei configure
 * document types and keyword types on my organization's OnBase, as me."
 * A near-duplicate of ../../onbase/[tenantId]/authorize/route.ts rather
 * than a shared implementation, because it really is a separate Hyland
 * OAuth client — see lib/onbase-app.ts's header for why the two connectors
 * are not merged.
 *
 * Authorization Code with PKCE (S256) against the customer's own Hyland
 * IdP — same grant type as the Document connector, and the same two
 * departures from the SaaS authorize routes: the authorization endpoint
 * comes from live OIDC discovery through the OnBase worker, and the flow
 * carries a PKCE code_verifier on the single-use state row (the shared
 * callback presents it at the token endpoint). The USER'S BROWSER can
 * reach the IdP — it lives on the same network — so the redirect works
 * even though this server could never fetch that URL itself.
 *
 * There is no scope picker: the IdP exposes one opaque API scope (the
 * configured scope name), plus openid for identity and offline_access for
 * a refresh token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getOnBaseApp, onbaseAuthorizeScopes, ONBASE_ADMIN_CONNECTOR } from '@/lib/onbase-app';
import { obDiscover, onbaseClientFailure } from '@/lib/onbase/service-client';
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
      { error: 'Not signed in', error_description: 'Sign in before connecting OnBase Administration' },
      { status: 401 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getOnBaseApp(tenantId, originResult.val, ONBASE_ADMIN_CONNECTOR);
  if (!app) {
    return NextResponse.json(
      { error: 'OnBase Administration integration not configured for this organization' },
      { status: 503 }
    );
  }

  // Live discovery through the worker — no cached endpoint in settings, so
  // a stale URL cannot outlive the IdP that issued it. The worker holds its
  // own short cache.
  const discovered = await obDiscover({ tenantId, connector: ONBASE_ADMIN_CONNECTOR });
  if (!discovered.ok) {
    const failure = onbaseClientFailure(discovered.err);
    return NextResponse.json(
      { error: `Could not reach the Hyland IdP: ${failure.message}` },
      { status: failure.status }
    );
  }

  // PKCE (RFC 7636): S256 challenge derived from a 32-byte verifier. The
  // verifier survives the redirect on the state row, never in the URL.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const scopes = onbaseAuthorizeScopes(app);

  const state = randomUUID();
  await db
    .insertInto('pending_oidc_signin')
    .values({
      id: randomUUID(),
      state,
      nonce: randomUUID(),
      tenant_id: tenantId,
      subject: session.subject,
      provider: ONBASE_ADMIN_CONNECTOR,
      scopes,
      code_verifier: codeVerifier,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const authUrl = new URL(discovered.val.authorizationEndpoint);
  authUrl.searchParams.append('client_id', app.clientId);
  authUrl.searchParams.append('redirect_uri', app.redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', scopes);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');

  return NextResponse.redirect(authUrl.toString());
}
