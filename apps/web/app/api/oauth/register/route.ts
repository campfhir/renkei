import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { generateSecret, hashToken } from '@/lib/mcp-token';
import { logger } from '@/lib/logger';

/**
 * Dynamic Client Registration endpoint (RFC 7591)
 * Allows clients like Claude Code to self-register without pre-configuration.
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
  // No tenant is known yet at system-level registration, so the platform
  // default applies; tenant-scoped registration consults the org's setting.
  if (!DEFAULT_ORG_SETTINGS.enableDcr) {
    return NextResponse.json(
      {
        error: 'unsupported_operation',
        error_description: 'Dynamic Client Registration is disabled',
      },
      { status: 403 }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'invalid_request', error_description: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    const { client_name, redirect_uris, response_types, grant_types } = body;

    // Validate required fields
    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return NextResponse.json(
        {
          error: 'invalid_request',
          error_description: 'redirect_uris is required and must be a non-empty array',
        },
        { status: 400 }
      );
    }

    // Validate redirect URIs are valid URLs
    for (const uri of redirect_uris) {
      try {
        new URL(uri);
      } catch {
        return NextResponse.json(
          {
            error: 'invalid_request',
            error_description: `Invalid redirect_uri: ${uri}`,
          },
          { status: 400 }
        );
      }
    }

    // Generate client credentials
    const clientId = `client_${randomUUID()}`;
    const clientSecret = generateSecret(32);

    // This system-level endpoint has no tenant of its own; it exists only
    // for a caller that reaches it without ever fetching tenant-scoped
    // discovery metadata (which now 404s at the system level — see
    // app/api/.well-known/oauth-authorization-server/route.ts). The only
    // signal available is the Referer header a browser sends when it
    // followed a link from the tenant-scoped MCP endpoint's own pages; a
    // bare API caller (curl, most DCR clients) sends none. There used to be
    // a hardcoded fallback to an all-zero "system tenant" here, but nothing
    // ever seeds that row — it was not a fallback, it was a guaranteed
    // "Tenant not found" for every caller that reached this line. An
    // unresolved tenant is now a clear, actionable error instead of a guess.
    const referer = request.headers.get('referer');
    const tenantId = referer?.match(/\/api\/mcp\/([a-f0-9-]+)/)?.[1];

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

    // Store the client
    await db
      .insertInto('oauth_clients')
      .values({
        client_id: clientId,
        tenant_id: tenantId,
        // Only the digest is stored; the secret itself exists solely in the
        // registration response below and in the client that receives it.
        client_secret_hash: hashToken(clientSecret),
        client_name: client_name || null,
        redirect_uris,
        response_types: response_types || ['code'],
        grant_types: grant_types || ['authorization_code', 'refresh_token'],
      })
      .execute();

    // Return registration response (RFC 7591 section 3.2)
    const response = {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client_name || undefined,
      redirect_uris,
      response_types: response_types || ['code'],
      grant_types: grant_types || ['authorization_code', 'refresh_token'],
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
