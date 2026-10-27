/**
 * Start the connect flow for one remote MCP server: "let Renkei use this
 * server as me." The server owns authorization, so this is the MCP
 * authorization flow — the delegate discovers the server's authorization
 * server and, where needed, registers Renkei with it (`mcp/prepare`), and
 * the person signs in THERE. Authorization Code with PKCE (S256); the
 * resource indicator (RFC 8707) names the MCP server so the token is issued
 * for it alone. The callback is the shared `/api/oauth/callback`.
 *
 * A server that needs no sign-in has nothing to connect: the page lists
 * its tools straight away.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getDatabase } from '@renkei/db';
import { delegateGrants } from '@renkei/delegate-client';
import { getServer, mcpProvider } from '@renkei/connector-mcp';
import { getSessionFromRequest } from '@/lib/session';
import { bindConnectFlow } from '@/lib/connect-flow-binding';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> }
): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { error: 'Not signed in', error_description: 'Sign in before connecting a server' },
      { status: 401 }
    );
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const server = await getServer(serverId);
  if (!server.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  if (!server.val || !server.val.enabled) {
    return NextResponse.json({ error: 'No such MCP server' }, { status: 404 });
  }
  if (server.val.authMode === 'none') {
    return NextResponse.json({ error: 'This server needs no sign-in' }, { status: 400 });
  }

  const origin = await getOrigin(request);
  if (!origin.ok) return NextResponse.json({ error: 'Config error' }, { status: 500 });
  const redirectUri = `${origin.val}/api/oauth/callback`;

  const prepared = await delegateGrants().mcpPrepare({ serverId, redirectUri });
  if (!prepared.ok) {
    logger.warn('MCP connect could not be prepared: {reason}', {
      component: 'mcp-servers',
      server: server.val.slug,
      reason: prepared.err.type,
      detail: prepared.err.message,
    });
    const status = prepared.err.type === 'NEEDS_CLIENT' ? 409 : 502;
    return NextResponse.json(
      {
        error: `Could not start the connection to ${server.val.name}`,
        error_description: prepared.err.message ?? prepared.err.type,
      },
      { status }
    );
  }
  if (prepared.val.authMode !== 'oauth') {
    return NextResponse.json({ error: 'This server needs no sign-in' }, { status: 400 });
  }
  const { authorizationEndpoint, clientId, scope, resource } = prepared.val;

  // PKCE (RFC 7636): the verifier survives the redirect on the state row.
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
      provider: mcpProvider(serverId),
      scopes: scope,
      code_verifier: codeVerifier,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  if (scope) authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', resource);

  // Bound to this browser: the callback requires the cookie this sets.
  return bindConnectFlow(NextResponse.redirect(authUrl.toString()), state);
}
