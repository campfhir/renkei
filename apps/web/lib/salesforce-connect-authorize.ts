/**
 * Start a connect to one Salesforce connector (one org) of either type —
 * CRM or admin (lib/salesforce-kinds.ts): "let Renkei work in this
 * Salesforce org as me."
 *
 * OAuth 2.0 Web Server flow with PKCE (S256) against that org's own My
 * Domain (lib/salesforce-app.ts), the shape the OnBase routes use for the
 * verifier: it rides the single-use state row with the connector's key,
 * and the shared callback presents it at that org's token endpoint. As with
 * GitHub, the person's narrowing of Renkei's capabilities is recorded on
 * the pending row (it becomes requested_scopes, which the tool gate narrows
 * by) but never travels to Salesforce, whose scope request is always the
 * fixed SALESFORCE_OAUTH_SCOPES.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { bindConnectFlow } from '@/lib/connect-flow-binding';
import { getSalesforceConnector } from '@/lib/salesforce-app';
import { SALESFORCE_OAUTH_SCOPES } from '@/lib/salesforce-scopes';
import type { SalesforceKind } from '@/lib/salesforce-kinds';
import { getOrigin } from '@/lib/get-origin';

export async function authorizeSalesforce(
  kind: SalesforceKind,
  request: NextRequest,
  { params }: { params: Promise<{ connector: string }> }
): Promise<NextResponse> {
  const { connector: connectorKey } = await params;
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
  const connector = await getSalesforceConnector(originResult.val, connectorKey, kind);
  if (!connector) {
    return NextResponse.json(
      { error: `That ${kind.label} connector is not set up, or is switched off` },
      { status: 503 }
    );
  }

  // Narrowing only: a capability outside this connector's ceiling is
  // refused, not silently dropped.
  const ceiling = new Set(connector.ceiling);
  const requestedParam = new URL(request.url).searchParams.get('scopes');
  let effectiveScopes = connector.ceiling.join(' ');
  if (requestedParam) {
    const requested = requestedParam.split(/[\s,+]+/).filter(Boolean);
    const outside = requested.filter(
      (scope) => !ceiling.has(scope) || !kind.allScopes.includes(scope)
    );
    if (outside.length > 0) {
      return NextResponse.json(
        { error: `Capabilities not allowed for ${connector.name}: ${outside.join(', ')}` },
        { status: 400 }
      );
    }
    effectiveScopes = requested.join(' ');
  }

  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomUUID();
  await getDataStore().pendingSignins.create({
    id: randomUUID(),
    state,
    nonce: randomUUID(),
    subject: session.subject,
    provider: kind.provider,
    connectorKey: connector.key,
    scopes: effectiveScopes,
    codeVerifier,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const authUrl = new URL(`${connector.myDomain}/services/oauth2/authorize`);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', connector.clientId);
  authUrl.searchParams.append('redirect_uri', connector.redirectUri);
  authUrl.searchParams.append('scope', SALESFORCE_OAUTH_SCOPES);
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');

  // Bound to this browser: the callback requires the cookie this sets.
  return bindConnectFlow(NextResponse.redirect(authUrl.toString()), state);
}
