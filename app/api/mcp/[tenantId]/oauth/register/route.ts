import { NextRequest, NextResponse } from 'next/server';
import { getConfig, isDcrEnabled } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

/**
 * Tenant-scoped Dynamic Client Registration endpoint (RFC 7591)
 * Clients register themselves for a specific tenant's MCP server.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const config = configResult.val;

  if (!isDcrEnabled(config.ENABLE_DCR)) {
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
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

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
    const clientSecret = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');

    // Store the client for this tenant
    await db
      .insertInto('oauth_clients')
      .values({
        client_id: clientId,
        tenant_id: tenantId,
        client_secret: clientSecret,
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
      token_endpoint_auth_method: 'client_secret_basic',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('[DCR] Registration error:', error);
    return NextResponse.json(
      { error: 'server_error', error_description: 'An error occurred during registration' },
      { status: 500 }
    );
  }
}
