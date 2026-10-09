import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { generateSecret, hashToken } from '@/lib/mcp-token';
import { SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS } from '@/lib/oauth-client-auth';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { readRegistration } from '@/lib/oauth-client-registration';
import { recordAuditEvent } from '@/lib/audit-events';

/**
 * Open by specification (RFC 7591) and each call writes a row, so the
 * throttle is what keeps it from being a client-row factory: a person sets
 * up one MCP client at a time, and a handful per ten minutes covers retries.
 */
const LIMITS = {
  perClient: { limit: 10, windowMs: 10 * 60_000 },
  global: { limit: 100, windowMs: 10 * 60_000 },
};

/**
 * Tenant-scoped Dynamic Client Registration endpoint (RFC 7591)
 * Clients register themselves for a specific tenant's MCP server.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ }> }
): Promise<NextResponse> {

  const verdict = checkInboundLimit(`oauth/register:${tenantId}`, request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'slow_down', error_description: 'Too many registration requests' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const settingsResult = await getOrgSettings();
  const settings = settingsResult.ok ? settingsResult.val : DEFAULT_ORG_SETTINGS;

  if (!settings.enableDcr) {
    return NextResponse.json(
      {
        error: 'unsupported_operation',
        error_description: 'Dynamic Client Registration is disabled',
      },
      { status: 403 }
    );
  }

  // The body is judged before anything is read from the database: a
  // registration that would be refused costs no query.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }
  const registration = readRegistration(body);
  if ('problem' in registration) {
    return NextResponse.json(
      { error: registration.error, error_description: registration.problem },
      { status: 400 }
    );
  }
  const { client_name, redirect_uris, response_types, grant_types } = registration;

  // Echo back the method the client asked for when it is one we accept,
  // rather than always answering client_secret_basic. Both are supported at
  // the token endpoint, and telling a client to use something other than what
  // it requested is a needless way to break the exchange.
  const requestedAuthMethod = registration.token_endpoint_auth_method;
  const tokenEndpointAuthMethod = SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.some(
    (method) => method === requestedAuthMethod
  )
    ? requestedAuthMethod
    : 'client_secret_basic';

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Verify tenant exists
    // Generate client credentials
    const clientId = `client_${randomUUID()}`;
    const clientSecret = generateSecret(32);

    // Store the client for this tenant
    await db
      .insertInto('oauth_clients')
      .values({
        client_id: clientId,
        // Only the digest is stored; the secret itself exists solely in the
        // registration response below and in the client that receives it.
        client_secret_hash: hashToken(clientSecret),
        client_name,
        redirect_uris,
        response_types,
        grant_types,
      })
      .execute();

    // Who registered is unknown by design (RFC 7591 is unauthenticated), so
    // the trail records what: the Access page and the consent page both
    // show a client's name, and this is where that name came from.
    recordAuditEvent({
      actorSubject: null,
      action: 'oauth.client_registered',
      targetKind: 'oauth_client',
      targetLabel: clientId,
      details: { clientId, clientName: client_name, redirectUris: redirect_uris },
    });

    // Return registration response (RFC 7591 section 3.2)
    const response = {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client_name ?? undefined,
      redirect_uris,
      response_types,
      grant_types,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    logger.error('Registration error: {detail}', {
      component: 'auth/oauth-register',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'server_error', error_description: 'An error occurred during registration' },
      { status: 500 }
    );
  }
}
