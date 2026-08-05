import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { randomUUID } from 'crypto';

/**
 * Tenant-scoped OAuth 2.0 Authorization endpoint (RFC 6749 section 3.1)
 * Initiates authorization flow for a tenant-specific MCP server.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const config = configResult.val;

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
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

    const searchParams = request.nextUrl.searchParams;
    const responseType = searchParams.get('response_type');
    const clientId = searchParams.get('client_id');
    const redirectUri = searchParams.get('redirect_uri');
    const state = searchParams.get('state');
    const scope = searchParams.get('scope');
    const codeChallenge = searchParams.get('code_challenge');
    const codeChallengeMethod = searchParams.get('code_challenge_method');

    // Validate required parameters
    if (!responseType || !clientId || !redirectUri || !state) {
      return NextResponse.json(
        {
          error: 'invalid_request',
          error_description:
            'Missing required parameters: response_type, client_id, redirect_uri, state',
        },
        { status: 400 }
      );
    }

    if (responseType !== 'code') {
      return NextResponse.json(
        {
          error: 'unsupported_response_type',
          error_description: 'Only "code" response_type is supported',
        },
        { status: 400 }
      );
    }

    // Look up client and verify it belongs to this tenant
    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', clientId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    if (!client) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }

    // Validate redirect URI
    if (!client.redirect_uris.includes(redirectUri)) {
      return NextResponse.json(
        {
          error: 'invalid_request',
          error_description: 'redirect_uri is not registered for this client',
        },
        { status: 400 }
      );
    }

    // Generate authorization code
    const code = `code_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + (config.AUTHORIZATION_CODE_TTL_SECONDS || 60) * 1000);

    // Store authorization code
    await db
      .insertInto('oauth_authorization_codes')
      .values({
        code,
        tenant_id: tenantId,
        client_id: clientId,
        subject: 'system',
        scope: scope || 'openid profile email',
        redirect_uri: redirectUri,
        code_challenge: codeChallenge || null,
        code_challenge_method: codeChallengeMethod || null,
        expires_at: expiresAt,
      })
      .execute();

    // Redirect to redirect_uri with code and state
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    return NextResponse.redirect(callbackUrl.toString());
  } catch (error) {
    console.error('[OAuth Authorize] Error:', error);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
