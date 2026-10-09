import { NextRequest, NextResponse } from 'next/server';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { generateSecret, hashToken } from '@/lib/mcp-token';
import { logger } from '@/lib/logger';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { readRegistration } from '@/lib/oauth-client-registration';
import { recordAuditEvent } from '@/lib/audit-events';

/**
 * Open by specification (RFC 7591) and each call writes a row, so the
 * throttle is what keeps it from being a client-row factory — the same
 * budget as the tenant-scoped endpoint, keyed on this system-level one.
 */
const LIMITS = {
  perClient: { limit: 10, windowMs: 10 * 60_000 },
  global: { limit: 100, windowMs: 10 * 60_000 },
};

/**
 * System-level Dynamic Client Registration endpoint (RFC 7591).
 *
 * This endpoint has no tenant of its own; it exists only for a caller that
 * reaches it without ever fetching tenant-scoped discovery metadata (which
 * 404s at the system level — see app/api/.well-known/oauth-authorization-
 * server/route.ts). The only signal available is the Referer header a
 * browser sends when it followed a link from the tenant-scoped MCP
 * endpoint's own pages; a bare API caller (curl, most DCR clients) sends
 * none. Once the tenant is known, THAT organization's registration setting
 * decides — this used to consult the platform default instead, so an org
 * that had switched registration off still took registrations here.
 *
 * Example request:
 *   POST /api/oauth/register
 *   Content-Type: application/json
 *   {
 *     "client_name": "Claude Code",
 *     "redirect_uris": ["http://localhost:3000/callback"],
 *     "response_types": ["code"],
 *     "grant_types": ["authorization_code", "refresh_token"]
 *   }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const verdict = checkInboundLimit('oauth/register', request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'slow_down', error_description: 'Too many registration requests' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const referer = request.headers.get('referer');
  const tenantId = referer?.match(/\/api\/mcp\/([a-f0-9-]{36})/i)?.[1];
  if (!tenantId) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        error_description:
          'Could not determine which tenant to register against. Discover the ' +
          'tenant-scoped registration endpoint from the resource_metadata field of ' +
          'the WWW-Authenticate challenge your MCP endpoint returned, or POST to ' +
          '/api/mcp/{tenantId}/oauth/register directly.',
      },
      { status: 400 }
    );
  }

  const settingsResult = await getOrgSettings(tenantId);
  const settings = settingsResult.ok ? settingsResult.val : DEFAULT_ORG_SETTINGS;
  if (!settings.enableDcr) {
    return NextResponse.json(
      {
        error: 'unsupported_operation',
        error_description: 'Dynamic Client Registration is disabled for this organization',
      },
      { status: 403 }
    );
  }

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

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Verify the tenant the Referer named actually exists.
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json(
        { error: 'invalid_request', error_description: 'Tenant not found' },
        { status: 400 }
      );
    }

    const clientId = `client_${randomUUID()}`;
    const clientSecret = generateSecret(32);

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

    recordAuditEvent({
      actorSubject: null,
      action: 'oauth.client_registered',
      targetKind: 'oauth_client',
      targetLabel: clientId,
      details: { clientId, clientName: client_name, redirectUris: redirect_uris, via: 'system' },
    });

    // Return registration response (RFC 7591 section 3.2)
    const response = {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client_name ?? undefined,
      redirect_uris,
      response_types,
      grant_types,
      // Recommended additional fields
      token_endpoint_auth_method: 'client_secret_basic',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    logger.error('Registration error: {error}', {
      component: 'auth/oauth-register',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { error: 'server_error', error_description: 'An error occurred during registration' },
      { status: 500 }
    );
  }
}
