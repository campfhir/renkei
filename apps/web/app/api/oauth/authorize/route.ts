import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';

/**
 * OAuth 2.0 Authorization endpoint (RFC 6749 section 3.1)
 * Called by the browser/client to initiate the authorization flow.
 *
 * For now, this auto-approves the request and returns a code immediately.
 * In production, you'd redirect to a login/consent page.
 *
 * Query parameters:
 *   - response_type: "code" (required)
 *   - client_id: client identifier (required)
 *   - redirect_uri: where to send the code (required)
 *   - state: CSRF token from client (required)
 *   - code_challenge: PKCE code challenge (optional)
 *   - code_challenge_method: S256 or plain (optional)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
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

    // Look up client
    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', clientId)
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
    const settingsResult = await getOrgSettings(client.tenant_id);
    const settings = settingsResult.ok ? settingsResult.val : DEFAULT_ORG_SETTINGS;
    const expiresAt = new Date(Date.now() + settings.authorizationCodeTtlSeconds * 1000);

    // Store authorization code
    await db
      .insertInto('oauth_authorization_codes')
      .values({
        code,
        tenant_id: client.tenant_id,
        client_id: clientId,
        subject: 'system', // In production, this would be the authenticated user
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
    logger.error('Error: {detail}', {
      component: 'auth/oauth-authorize',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
