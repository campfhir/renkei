import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrgSettings, type OrgSettings } from '@renkei/settings';
import { getDataStore } from '@renkei/db';
import { randomUUID } from 'crypto';
import { storeAccessToken, generateSecret, hashToken, digestsMatch } from '@/lib/mcp-token';
import {
  readClientCredentials,
  verifyClientSecret,
  type ClientCredentials,
} from '@/lib/oauth-client-auth';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';
import { isWellFormedVerifier, verifierMatchesChallenge } from '@/lib/oauth-pkce';

/**
 * Unauthenticated until the client secret verifies, so throttled per
 * forwarded client address and per tenant before anything is read. A
 * well-behaved MCP client refreshes once an hour; sixty a minute from one
 * address is a loop or a guesser, and the per-tenant ceiling bounds what a
 * spoofed address can widen that to.
 */
const LIMITS = {
  perClient: { limit: 60, windowMs: 60_000 },
  global: { limit: 1_200, windowMs: 60_000 },
};

/**
 * OAuth 2.0 Token endpoint (RFC 6749)
 * Exchanges authorization codes for access tokens and refresh tokens.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const verdict = checkInboundLimit('oauth/token', request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'slow_down', error_description: 'Too many token requests' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const settingsResult = await getOrgSettings();
  if (!settingsResult.ok) {
    logger.error('Could not read org settings: {error}', {
      component: 'auth/oauth-token',
      error: settingsResult.err.message ?? settingsResult.err.type,
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const settings = settingsResult.val;

  try {
    // Verify tenant exists
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

    // The client authenticates before the grant type is even looked at:
    // nothing the request names decides whether it is checked.
    const authenticated = await authenticateClient(credentials);
    if (authenticated instanceof NextResponse) return authenticated;
    const clientId = authenticated.clientId;

    const grantType = params.grant_type;
    if (grantType === 'authorization_code') {
      return redeemCode(params, clientId, settings);
    } else if (grantType === 'refresh_token') {
      return exchangeRefreshToken(params, clientId, settings);
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
    logger.error('Error: {detail}', {
      component: 'auth/oauth-token',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

/** The client's own credentials, checked: its id, or the 401 to send. */
async function authenticateClient(
  credentials: ClientCredentials | null
): Promise<{ clientId: string } | NextResponse> {
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

  const client = await getDataStore().oauthConsents.getClientCredentials(client_id);

  // Constant-time comparison of digests; the secret itself is not stored.
  if (!client) {
    return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
  }

  const secretCheck = verifyClientSecret(client.secretHash, client_secret, hashToken, digestsMatch);
  if (secretCheck !== 'ok') {
    if (secretCheck === 'unusable') {
      // Not the client's fault, and not something it can act on: no digest is
      // stored for this row, so nothing it presents can ever match.
      logger.error('Client row has no usable secret digest', {
        component: 'auth/oauth-token',
        client_id,
        hint: 'oauth_clients.client_secret_hash is NULL or absent — check migration 012 has run',
      });
    }
    return NextResponse.json(
      {
        error: 'invalid_client',
        error_description:
          secretCheck === 'unusable'
            ? 'This client cannot be authenticated on this server. Register again.'
            : 'Client authentication failed',
      },
      { status: 401 }
    );
  }
  return { clientId: client_id };
}

async function redeemCode(
  params: Record<string, string>,
  client_id: string,
  settings: OrgSettings
): Promise<NextResponse> {
  const { code, redirect_uri, code_verifier } = params;

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
    // Retrieve and validate authorization code
    const authCode = await getDataStore().oauthConsents.getAuthorizationCode(code);

    if (!authCode) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Authorization code not found' },
        { status: 400 }
      );
    }

    if (authCode.clientId !== client_id) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Client ID mismatch' },
        { status: 400 }
      );
    }

    if (new Date() > authCode.expiresAt) {
      await getDataStore().oauthConsents.deleteAuthorizationCode(code);
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Authorization code expired' },
        { status: 400 }
      );
    }

    if (authCode.redirectUri !== redirect_uri) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Redirect URI mismatch' },
        { status: 400 }
      );
    }

    // PKCE is not optional: the authorize endpoint refuses a request
    // without an S256 challenge, so a code row without one was not minted
    // by this server's current flow and is not exchanged.
    if (authCode.codeChallengeMethod !== 'S256' || !authCode.codeChallenge) {
      await getDataStore().oauthConsents.deleteAuthorizationCode(code);
      return NextResponse.json(
        {
          error: 'invalid_grant',
          error_description: 'Authorization code was issued without PKCE; authorize again',
        },
        { status: 400 }
      );
    }
    if (!isWellFormedVerifier(code_verifier)) {
      return NextResponse.json(
        {
          error: 'invalid_request',
          error_description:
            'code_verifier is required: 43 to 128 unreserved characters (PKCE, RFC 7636)',
        },
        { status: 400 }
      );
    }
    if (!verifierMatchesChallenge(code_verifier, authCode.codeChallenge)) {
      // A wrong verifier burns the code: whoever holds it is guessing.
      await getDataStore().oauthConsents.deleteAuthorizationCode(code);
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'PKCE verification failed' },
        { status: 400 }
      );
    }

    // Generate tokens
    const accessToken = generateSecret(32);
    const refreshToken = generateSecret(32);
    const tokenExpiresIn = settings.accessTokenTtlMinutes * 60;

    // Store refresh token
    const refreshTokenId = randomUUID();
    const refreshTokenExpiresAt = new Date(
      Date.now() + settings.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    );

    await getDataStore().oauthTokens.insertRefreshToken({
      tokenId: refreshTokenId,
      clientId: client_id,
      subject: authCode.subject,
      scope: authCode.scope,
      // Carried forward so a later refresh (below) can reissue an access
      // token with the same roles, without re-touching the browser session.
      roles: authCode.roles,
      // Only the digest is kept; the token itself exists solely in the
      // response below and in the client that receives it.
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshTokenExpiresAt,
    });

    // Persist the access token so the MCP transport can identify its caller.
    // Only the digest is stored; this is the sole record binding the token to a user.
    await storeAccessToken({
      token: accessToken,
      clientId: client_id,
      subject: authCode.subject,
      scope: authCode.scope,
      roles: authCode.roles,
      ttlSeconds: tokenExpiresIn,
    });

    // Delete the authorization code (one-time use)
    await getDataStore().oauthConsents.deleteAuthorizationCode(code);

    return NextResponse.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: tokenExpiresIn,
      refresh_token: refreshToken,
      scope: authCode.scope || 'openid profile email',
    });
  } catch (error) {
    logger.error('Authorization code grant error: {detail}', {
      component: 'auth/oauth-token',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

async function exchangeRefreshToken(
  params: Record<string, string>,
  client_id: string,
  settings: OrgSettings
): Promise<NextResponse> {
  const { refresh_token } = params;

  if (!refresh_token) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing required parameter: refresh_token' },
      { status: 400 }
    );
  }

  try {
    // Rotation with reuse detection (migration 147), in one transaction so
    // the presented token is retired exactly when its successor exists.
    // The row is locked for the duration: two concurrent refreshes with the
    // same token must serialize, and the second must see the first's
    // rotation rather than both succeeding.
    const presentedHash = hashToken(refresh_token);
    const accessToken = generateSecret(32);
    const nextRefreshToken = generateSecret(32);
    const tokenExpiresIn = settings.accessTokenTtlMinutes * 60;

    // Matched on the digest — the presented token is never compared against
    // anything stored in the clear. The store carries out the whole exchange
    // (oauthTokens.rotateRefreshToken):
    //
    //   - an expired token takes its family with it: every rotated
    //     predecessor goes too;
    //   - a token already rotated is REUSE. It was already exchanged for a
    //     successor, so two parties hold copies of the family's history —
    //     the client (a retry that lost its response) or whoever lifted the
    //     token from it. The server cannot tell which, so the whole family
    //     dies: every refresh token descended from this authorization, and
    //     the subject's access tokens for this client. A legitimate client
    //     re-authorizes through the browser; a thief's copies stop working;
    //   - otherwise the successor joins the family with the family's
    //     absolute lifetime, fixed at the original authorization (rotation
    //     never extends it, so stale roles and a stolen copy alike can
    //     outlive sign-in by at most refreshTokenTtlDays), and the access
    //     token is stored for the original grant's subject — the refreshed
    //     token acts as the same person, not as whoever holds the refresh
    //     token. Its roles are re-derived from the subject's CURRENT browser
    //     session when one is live — the freshest thing the IdP has asserted
    //     about them — and otherwise the frozen roles stand.
    const outcome = await getDataStore().oauthTokens.rotateRefreshToken({
      presentedHash,
      clientId: client_id,
      now: new Date(),
      next: { tokenId: randomUUID(), tokenHash: hashToken(nextRefreshToken) },
      access: {
        tokenHash: hashToken(accessToken),
        expiresAt: new Date(Date.now() + tokenExpiresIn * 1000),
      },
    });

    if (outcome.outcome === 'reused') {
      logger.warn('Refresh token reuse detected; family revoked', {
        component: 'auth/oauth-token',
        client_id,
        subject: outcome.subject,
        familyId: outcome.familyId,
      });
    }
    if (outcome.outcome !== 'rotated') {
      const refusal = {
        not_found: 'Refresh token not found',
        client_mismatch: 'Client ID mismatch',
        expired: 'Refresh token expired',
        reused: 'Refresh token reuse detected; authorize again',
      }[outcome.outcome];
      return NextResponse.json(
        { error: 'invalid_grant', error_description: refusal },
        { status: 400 }
      );
    }

    return NextResponse.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: tokenExpiresIn,
      refresh_token: nextRefreshToken,
      scope: outcome.scope || 'openid profile email',
    });
  } catch (error) {
    logger.error('Refresh token grant error: {detail}', {
      component: 'auth/oauth-token',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
