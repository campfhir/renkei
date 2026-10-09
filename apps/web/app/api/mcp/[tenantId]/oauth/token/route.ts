import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrgSettings, type OrgSettings } from '@renkei/settings';
import { getDatabase } from '@renkei/db';
import { randomUUID, createHash } from 'crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { storeAccessToken, generateSecret, hashToken, digestsMatch } from '@/lib/mcp-token';
import {
  readClientCredentials,
  verifyClientSecret,
  type ClientCredentials,
} from '@/lib/oauth-client-auth';
import { checkInboundLimit } from '@/lib/inbound-rate-limit';

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
 * Tenant-scoped OAuth 2.0 Token endpoint (RFC 6749)
 * Exchanges authorization codes for access tokens and refresh tokens.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const verdict = checkInboundLimit(`oauth/token:${tenantId}`, request, LIMITS);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: 'slow_down', error_description: 'Too many token requests' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const settingsResult = await getOrgSettings(tenantId);
  if (!settingsResult.ok) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  const settings = settingsResult.val;

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

    // A token request names its own grant type by definition; each handler
    // then authenticates the client and the grant it presents.
    // prettier-ignore
    if (grantType === 'authorization_code') { // codeql[js/user-controlled-bypass]
      return handleAuthorizationCodeGrant(params, credentials, db, settings, tenantId);
    } else if (grantType === 'refresh_token') {
      return handleRefreshTokenGrant(params, credentials, db, settings, tenantId);
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

async function handleAuthorizationCodeGrant(
  params: Record<string, string>,
  credentials: ClientCredentials | null,
  db: Kysely<DB>,
  settings: OrgSettings,
  tenantId: string
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
    // Verify client credentials and tenant ownership
    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', client_id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    // Constant-time comparison of digests; the secret itself is not stored.
    if (!client) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }

    const secretCheck = verifyClientSecret(
      client.client_secret_hash,
      client_secret,
      hashToken,
      digestsMatch
    );
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

    // Retrieve and validate authorization code
    const authCode = await db
      .selectFrom('oauth_authorization_codes')
      .selectAll()
      .where('code', '=', code)
      .where('tenant_id', '=', tenantId)
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
    const accessToken = generateSecret(32);
    const refreshToken = generateSecret(32);
    const tokenExpiresIn = settings.accessTokenTtlMinutes * 60;

    // Store refresh token
    const refreshTokenId = randomUUID();
    const refreshTokenExpiresAt = new Date(
      Date.now() + settings.refreshTokenTtlDays * 24 * 60 * 60 * 1000
    );

    await db
      .insertInto('oauth_refresh_tokens')
      .values({
        token_id: refreshTokenId,
        tenant_id: tenantId,
        client_id,
        subject: authCode.subject,
        scope: authCode.scope,
        // Carried forward so a later refresh (below) can reissue an access
        // token with the same roles, without re-touching the browser session.
        roles: authCode.roles,
        // Only the digest is kept; the token itself exists solely in the
        // response below and in the client that receives it.
        token_hash: hashToken(refreshToken),
        expires_at: refreshTokenExpiresAt,
      })
      .execute();

    // Persist the access token so the MCP transport can identify its caller.
    // Only the digest is stored; this is the sole record binding the token to a user.
    await storeAccessToken({
      token: accessToken,
      tenantId,
      clientId: client_id,
      subject: authCode.subject,
      scope: authCode.scope,
      roles: authCode.roles,
      ttlSeconds: tokenExpiresIn,
    });

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
    logger.error('Authorization code grant error: {detail}', {
      component: 'auth/oauth-token',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}

async function handleRefreshTokenGrant(
  params: Record<string, string>,
  credentials: ClientCredentials | null,
  db: Kysely<DB>,
  settings: OrgSettings,
  tenantId: string
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
    // Verify client credentials and tenant ownership
    const client = await db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', client_id)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();

    // Constant-time comparison of digests; the secret itself is not stored.
    if (!client) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }

    const secretCheck = verifyClientSecret(
      client.client_secret_hash,
      client_secret,
      hashToken,
      digestsMatch
    );
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

    // Rotation with reuse detection (migration 147), in one transaction so
    // the presented token is retired exactly when its successor exists.
    // The row is locked for the duration: two concurrent refreshes with the
    // same token must serialize, and the second must see the first's
    // rotation rather than both succeeding.
    const presentedHash = hashToken(refresh_token);
    const accessToken = generateSecret(32);
    const nextRefreshToken = generateSecret(32);
    const tokenExpiresIn = settings.accessTokenTtlMinutes * 60;

    const outcome = await db.transaction().execute(async (trx) => {
      // Matched on the digest — the presented token is never compared
      // against anything stored in the clear.
      const token = await trx
        .selectFrom('oauth_refresh_tokens')
        .selectAll()
        .where('token_hash', '=', presentedHash)
        .where('tenant_id', '=', tenantId)
        .forUpdate()
        .executeTakeFirst();

      if (!token || !digestsMatch(token.token_hash, presentedHash)) {
        return { error: 'Refresh token not found' } as const;
      }

      if (token.client_id !== client_id) {
        return { error: 'Client ID mismatch' } as const;
      }

      if (new Date() > token.expires_at) {
        // The family's time is up: every rotated predecessor goes with it.
        await trx
          .deleteFrom('oauth_refresh_tokens')
          .where('tenant_id', '=', tenantId)
          .where('family_id', '=', token.family_id)
          .execute();
        return { error: 'Refresh token expired' } as const;
      }

      if (token.rotated_at !== null) {
        // REUSE. This token was already exchanged for a successor, so two
        // parties hold copies of the family's history — the client (a retry
        // that lost its response) or whoever lifted the token from it. The
        // server cannot tell which, so the whole family dies: every refresh
        // token descended from this authorization, and the subject's access
        // tokens for this client. A legitimate client re-authorizes through
        // the browser; a thief's copies stop working now.
        await trx
          .deleteFrom('oauth_refresh_tokens')
          .where('tenant_id', '=', tenantId)
          .where('family_id', '=', token.family_id)
          .execute();
        await trx
          .deleteFrom('oauth_access_tokens')
          .where('tenant_id', '=', tenantId)
          .where('client_id', '=', client_id)
          .where('subject', '=', token.subject)
          .where('application', '=', 'jira')
          .execute();
        logger.warn('Refresh token reuse detected; family revoked', {
          component: 'auth/oauth-token',
          tenantId,
          client_id,
          subject: token.subject,
          familyId: token.family_id,
        });
        return { error: 'Refresh token reuse detected; authorize again' } as const;
      }

      // The roles the refreshed token acts with are re-derived from the
      // subject's CURRENT browser session when one exists — the freshest
      // thing the IdP has asserted about them, re-minted at every sign-in —
      // rather than frozen at the original authorization. Without a live
      // session the frozen roles stand, bounded by the family's lifetime
      // below (there is no other durable store of a person's roles: the
      // IdP asserts them only at sign-in).
      const roles = await currentRolesFor(trx, tenantId, token.subject, token.roles);

      await trx
        .updateTable('oauth_refresh_tokens')
        .set({ rotated_at: new Date() })
        .where('token_id', '=', token.token_id)
        .execute();
      await trx
        .insertInto('oauth_refresh_tokens')
        .values({
          token_id: randomUUID(),
          tenant_id: tenantId,
          client_id,
          subject: token.subject,
          scope: token.scope,
          roles,
          token_hash: hashToken(nextRefreshToken),
          family_id: token.family_id,
          // The family's absolute lifetime, fixed at the original
          // authorization: rotation never extends it, so stale roles and a
          // stolen copy alike can outlive sign-in by at most
          // refreshTokenTtlDays.
          expires_at: token.expires_at,
        })
        .execute();

      // Carry the original grant's subject forward — the refreshed token
      // must act as the same person, not as whoever holds the refresh token.
      await storeAccessToken({
        token: accessToken,
        tenantId,
        clientId: client_id,
        subject: token.subject,
        scope: token.scope,
        roles,
        ttlSeconds: tokenExpiresIn,
        db: trx,
      });

      return { scope: token.scope } as const;
    });

    if ('error' in outcome) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: outcome.error },
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

/**
 * The subject's roles as of their most recent live browser session in this
 * tenant, or `fallback` when they hold none. A session's roles are what the
 * IdP asserted at that sign-in (lib/session.ts), so the newest one is the
 * closest thing to "current" the server has.
 */
async function currentRolesFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  fallback: string[]
): Promise<string[]> {
  const live = await db
    .selectFrom('sessions')
    .select('roles')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return live ? live.roles : fallback;
}

function computeS256(codeVerifier: string): string {
  return createHash('sha256')
    .update(codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
