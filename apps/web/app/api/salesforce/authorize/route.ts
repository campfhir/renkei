/**
 * Start a Salesforce CRM connect: "let Renkei work in Salesforce as me."
 *
 * OAuth 2.0 Web Server flow with PKCE (S256) against the org's own My
 * Domain (lib/salesforce-app.ts), the shape the OnBase routes use for the
 * verifier: it rides the single-use state row, and the shared callback
 * presents it at the token exchange. As with GitHub, the person's
 * narrowing of Renkei's capabilities is recorded on the pending row (it
 * becomes requested_scopes, which the tool gate narrows by) but never
 * travels to Salesforce, whose scope request is always the fixed
 * SALESFORCE_OAUTH_SCOPES.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { bindConnectFlow } from '@/lib/connect-flow-binding';
import { getSalesforceApp, SALESFORCE_CONNECTOR } from '@/lib/salesforce-app';
import { ALL_SALESFORCE_SCOPES, SALESFORCE_OAUTH_SCOPES } from '@/lib/salesforce-scopes';
import { getOrigin } from '@/lib/get-origin';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;
  // The resulting grant is bound to whoever completes this flow.
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { error: 'Not signed in', error_description: 'Sign in before connecting Salesforce' },
      { status: 401 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getSalesforceApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Salesforce connector not configured for this organization' },
      { status: 503 }
    );
  }

  // Narrowing only: a capability outside the org's ceiling is refused, not
  // silently dropped.
  const ceiling = new Set(app.scopes.split(/\s+/));
  const requestedParam = new URL(request.url).searchParams.get('scopes');
  let effectiveScopes = app.scopes;
  if (requestedParam) {
    const requested = requestedParam.split(/[\s,+]+/).filter(Boolean);
    const outside = requested.filter(
      (scope) => !ceiling.has(scope) || !ALL_SALESFORCE_SCOPES.includes(scope)
    );
    if (outside.length > 0) {
      return NextResponse.json(
        { error: `Capabilities not allowed by this organization: ${outside.join(', ')}` },
        { status: 400 }
      );
    }
    effectiveScopes = requested.join(' ');
  }

  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomUUID();
  await db
    .insertInto('pending_oidc_signin')
    .values({
      id: randomUUID(),
      state,
      nonce: randomUUID(),
      subject: session.subject,
      provider: SALESFORCE_CONNECTOR,
      scopes: effectiveScopes,
      code_verifier: codeVerifier,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const authUrl = new URL(`${app.myDomain}/services/oauth2/authorize`);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', app.clientId);
  authUrl.searchParams.append('redirect_uri', app.redirectUri);
  authUrl.searchParams.append('scope', SALESFORCE_OAUTH_SCOPES);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');

  // Bound to this browser: the callback requires the cookie this sets.
  return bindConnectFlow(NextResponse.redirect(authUrl.toString()), state);
}
