import { NextRequest, NextResponse } from 'next/server';
import { getConfig, type Env } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { randomUUID, createHash } from 'crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@/lib/db.types';
import { generateSecret, hashToken, digestsMatch } from '@/lib/mcp-token';
import { readClientCredentials, type ClientCredentials } from '@/lib/oauth-client-auth';
import { logger } from '@/lib/logger';

/**
 * OAuth 2.0 Token endpoint (RFC 6749)
 * Exchanges authorization codes for access tokens and refresh tokens.
 *
 * Supports:
 *   - authorization_code grant (code exchange)
 *   - refresh_token grant (token refresh)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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
    // Parse request body
    const contentType = request.headers.get('content-type');
    let params: Record<string, string> = {};

    if (contentType?.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      const searchParams = new URLSearchParams(text);
      for (const [key, value] of searchParams.entries()) {
        params[key] = value;
      }
    } else if (contentType?.includes('application/json')) {
      params = await request.json();
    } else {
      return NextResponse.json(
        {
          error: 'invalid_request',
          error_description:
            'Content-Type must be application/x-www-form-urlencoded or application/json',
        },
        { status: 400 }
      );
    }

    // Accepted from the Authorization header as well as the body: the
    // registration response tells clients to use client_secret_basic.
    const credentials = readClientCredentials(request.headers.get('authorization'), params);

    const grantType = params.grant_type;

    if (grantType === 'authorization_code') {
      return handleAuthorizationCodeGrant(params, credentials, db, config);
    } else if (grantType === 'refresh_token') {
      return handleRefreshTokenGrant(params, credentials, db, config);
    } else {
      return NextResponse.json(
        {
          error: 'unsupported_grant_type',
          error_description: `Grant type '${grantType}' is not supported`,
        },
        { status: 400 }
      );
    }
  } catch (error) {
    logger.error('[OAuth Token] Error: {error}', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

async function handleAuthorizationCodeGrant(
  params: Record<string, string>,
  credentials: ClientCredentials | null,
  db: Kysely<DB>,
  config: Env
): Promise<NextResponse> {
  const { code, redirect_uri, code_verifier } = params;

  if (!credentials) {
    return NextResponse.json(
      {
        error: 'invalid_client',
        error_description:
          'Client authentication required: send an Authorization: Basic header, or client_id and client_secret in the body',
      },
      { status: 401 }
    );
  }
  const { clientId: client_id, clientSecret: client_secret } = credentials;

  // Validate required parameters
  if (!code || !redirect_uri) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        error_description: 'Missing required parameters: code, redirect_uri',
      },
      { status: 400 }
    );
  }

  try {
    // Verify client credentials
    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', client_id)
      .executeTakeFirst();

    // Constant-time comparison of digests; the secret itself is not stored.
    if (!client || !digestsMatch(client.client_secret_hash, hashToken(client_secret))) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }

    // Retrieve and validate authorization code
    const authCode = await db
      .selectFrom('oauth_authorization_codes')
      .selectAll()
      .where('code', '=', code)
      .executeTakeFirst();

    if (!authCode) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Authorization code not found' },
        { status: 400 }
      );
    }

    if (authCode.client_id !== client_id) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Client ID mismatch' },
        { status: 400 }
      );
    }

    if (new Date() > authCode.expires_at) {
      // Clean up expired code
      await db.deleteFrom('oauth_authorization_codes').where('code', '=', code).execute();
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Authorization code expired' },
        { status: 400 }
      );
    }

    if (authCode.redirect_uri !== redirect_uri) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Redirect URI mismatch' },
        { status: 400 }
      );
    }

    // Validate PKCE if code_challenge was present
    if (authCode.code_challenge && authCode.code_challenge_method) {
      if (!code_verifier) {
        return NextResponse.json(
          { error: 'invalid_request', error_description: 'code_verifier is required for PKCE' },
          { status: 400 }
        );
      }

      const challenge =
        authCode.code_challenge_method === 'S256' ? computeS256(code_verifier) : code_verifier;

      if (challenge !== authCode.code_challenge) {
        return NextResponse.json(
          { error: 'invalid_grant', error_description: 'PKCE verification failed' },
          { status: 400 }
        );
      }
    }

    // Generate tokens
    const accessToken = generateToken(32);
    const refreshToken = generateToken(32);
    const tokenExpiresIn = config.ACCESS_TOKEN_TTL_MINUTES * 60;

    // Store refresh token
    const refreshTokenId = randomUUID();
    const refreshTokenExpiresAt = new Date(
      Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
    );

    await db
      .insertInto('oauth_refresh_tokens')
      .values({
        token_id: refreshTokenId,
        tenant_id: authCode.tenant_id,
        client_id,
        subject: authCode.subject,
        scope: authCode.scope,
        // Only the digest is kept; the token itself exists solely in the
        // response below and in the client that receives it.
        token_hash: hashToken(refreshToken),
        expires_at: refreshTokenExpiresAt,
      })
      .execute();

    // Delete the authorization code (one-time use)
    await db.deleteFrom('oauth_authorization_codes').where('code', '=', code).execute();

    return NextResponse.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: tokenExpiresIn,
      refresh_token: refreshToken,
      scope: authCode.scope || 'openid profile email',
    });
  } catch (error) {
    logger.error('[OAuth Token] Authorization code grant error: {error}', {
      error: error instanceof Error ? error.message : String(error),
      clientId: client_id,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

async function handleRefreshTokenGrant(
  params: Record<string, string>,
  credentials: ClientCredentials | null,
  db: Kysely<DB>,
  config: Env
): Promise<NextResponse> {
  const { refresh_token } = params;

  if (!credentials) {
    return NextResponse.json(
      {
        error: 'invalid_client',
        error_description:
          'Client authentication required: send an Authorization: Basic header, or client_id and client_secret in the body',
      },
      { status: 401 }
    );
  }
  const { clientId: client_id, clientSecret: client_secret } = credentials;

  if (!refresh_token) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing required parameter: refresh_token' },
      { status: 400 }
    );
  }

  try {
    // Verify client credentials
    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', client_id)
      .executeTakeFirst();

    // Constant-time comparison of digests; the secret itself is not stored.
    if (!client || !digestsMatch(client.client_secret_hash, hashToken(client_secret))) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }

    // Find the refresh token. Matched on the digest — the presented token is
    // never compared against anything stored in the clear.
    const presentedHash = hashToken(refresh_token);
    const token = await db
      .selectFrom('oauth_refresh_tokens')
      .selectAll()
      .where('token_hash', '=', presentedHash)
      .executeTakeFirst();

    if (!token || !digestsMatch(token.token_hash, presentedHash)) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Refresh token not found' },
        { status: 400 }
      );
    }

    if (token.client_id !== client_id) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Client ID mismatch' },
        { status: 400 }
      );
    }

    if (new Date() > token.expires_at) {
      await db.deleteFrom('oauth_refresh_tokens').where('token_id', '=', token.token_id).execute();
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Refresh token expired' },
        { status: 400 }
      );
    }

    // Generate new access token
    const accessToken = generateToken(32);
    const tokenExpiresIn = config.ACCESS_TOKEN_TTL_MINUTES * 60;

    return NextResponse.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: tokenExpiresIn,
      scope: token.scope || 'openid profile email',
    });
  } catch (error) {
    logger.error('[OAuth Token] Refresh token grant error: {error}', {
      error: error instanceof Error ? error.message : String(error),
      clientId: client_id,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

function generateToken(byteLength: number): string {
  return generateSecret(byteLength);
}

function computeS256(codeVerifier: string): string {
  return createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
