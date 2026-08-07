/**
 * Bearer tokens for the MCP transport endpoint.
 *
 * Access tokens issued by /api/mcp/{tenantId}/oauth/token were previously
 * generated and discarded, leaving the transport with no way to identify its
 * caller — it fell back to "first grant for the tenant", so every user of a
 * tenant acted as the same Atlassian account. Tokens are now persisted as a
 * SHA-256 digest so a database leak does not yield usable bearer credentials.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { getDatabase } from '@renkei/db';
import { logger } from '@/lib/logger';

/**
 * Digest a bearer credential for storage.
 *
 * Used for both access tokens and refresh tokens. Neither is ever read back —
 * the server issues the value once and thereafter only checks a presented one
 * against it — so storing a digest costs nothing and means a read of these
 * tables yields no usable credential. Migration 011 covers the reasoning for
 * preferring this over encryption.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two digests.
 *
 * The queries that use these digests already match in the database, so this
 * exists to keep the comparison safe if a future change moves the check into
 * application code.
 */
export function digestsMatch(a: unknown, b: unknown): boolean {
  // Fails closed on anything that is not a string. One argument is always a
  // value read from the database, and a column that is absent or NULL arrives
  // here as undefined: `Buffer.from(undefined)` throws ERR_INVALID_ARG_TYPE,
  // which surfaced at the token endpoint as a 500 rather than as the
  // authentication failure it is.
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Generate a bearer token, refresh token, or client secret.
 *
 * These were previously built from `Math.random()`, which is V8's xorshift128+ —
 * not a CSPRNG, and its internal state is recoverable from a handful of observed
 * outputs. Since dynamic client registration is open, an attacker could obtain
 * one legitimate token, recover the state, and predict other users' bearer
 * tokens — full use of a victim's Jira grant without ever seeing the Atlassian
 * token, defeating the digest-only storage below.
 */
export function generateSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

/** Extract the credential from an `Authorization: Bearer <token>` header. */
export function getBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/**
 * Product surface a token authorizes. Only Jira exists today; validation is
 * explicit about it so adding Confluence later cannot silently widen an
 * existing token's reach.
 */
export type Application = 'jira';

export interface AccessTokenRecord {
  subject: string;
  clientId: string;
  scope: string | null;
  application: string;
}

export async function storeAccessToken(params: {
  token: string;
  tenantId: string;
  clientId: string;
  subject: string;
  scope: string | null;
  ttlSeconds: number;
  application?: Application;
}): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('Database unavailable');

  await dbResult.val
    .insertInto('oauth_access_tokens')
    .values({
      token_hash: hashToken(params.token),
      tenant_id: params.tenantId,
      client_id: params.clientId,
      subject: params.subject,
      application: params.application ?? 'jira',
      scope: params.scope,
      expires_at: new Date(Date.now() + params.ttlSeconds * 1000),
    })
    .execute();
}

/**
 * Resolve a bearer token to its owner, or null if unknown, expired, or issued
 * for a different tenant. Callers must fail closed on null.
 */
export async function resolveAccessToken(
  token: string,
  tenantId: string,
  application: Application = 'jira'
): Promise<AccessTokenRecord | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const db = dbResult.val;

  const tokenHash = hashToken(token);

  const row = await db
    .selectFrom('oauth_access_tokens')
    .select([
      'token_hash',
      'subject',
      'client_id',
      'scope',
      'expires_at',
      'tenant_id',
      'application',
    ])
    .where('token_hash', '=', tokenHash)
    .where('tenant_id', '=', tenantId)
    .where('application', '=', application)
    .executeTakeFirst();

  if (!row) return null;

  // The lookup above already matched on the digest; this guards against a
  // non-constant-time comparison sneaking in via a future query change.
  if (!digestsMatch(row.token_hash, tokenHash)) return null;

  if (new Date(row.expires_at) < new Date()) {
    await db.deleteFrom('oauth_access_tokens').where('token_hash', '=', tokenHash).execute();
    logger.debug('[MCP Token] Expired access token discarded', { tenantId });
    return null;
  }

  return {
    subject: row.subject,
    clientId: row.client_id,
    scope: row.scope,
    application: row.application,
  };
}

/** RFC 6750 challenge for a missing or rejected bearer token. */
export function unauthorizedResponse(tenantId: string, origin: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: detail },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        // RFC 9728: this must be the *protected resource* metadata document.
        // It pointed at the authorization server metadata, so a client followed
        // it, looked for `authorization_servers`, found none, and never reached
        // the registration endpoint.
        'WWW-Authenticate': `Bearer realm="renkei", error="invalid_token", resource_metadata="${origin}/api/mcp/${tenantId}/.well-known/oauth-protected-resource"`,
      },
    }
  );
}
