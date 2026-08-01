/**
 * Secrets Renkei issues, and the PKCE check.
 *
 * Every value here is 32 bytes of CSPRNG output behind a readable prefix. The
 * prefix is not decoration: a leaked string is instantly identifiable in a log
 * or a paste, and secret scanners can be pointed at it.
 *
 * Storage is plain SHA-256. That is the right choice *because* these are not
 * passwords — there is no dictionary to grind and no user-chosen entropy to
 * protect, so a work factor would only slow down the authentication path. What
 * the hash buys is that a database dump yields no usable bearer token.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_TOKEN_PREFIX = 'renkei_at_';
export const REFRESH_TOKEN_PREFIX = 'renkei_rt_';
export const AUTHORIZATION_CODE_PREFIX = 'renkei_ac_';
export const CLIENT_SECRET_PREFIX = 'renkei_cs_';
export const CLIENT_ID_PREFIX = 'renkei_id_';
/** The `/me` cookie. Distinct from a bearer token so the two cannot be confused. */
export const PORTAL_COOKIE_PREFIX = 'renkei_pc_';
/** The `/platform` cookie. The fourth kind of session, and its own prefix. */
export const PLATFORM_COOKIE_PREFIX = 'renkei_pl_';
/**
 * The secret in an onboarding link.
 *
 * Worth its own prefix beyond the usual reason: this one travels in a URL path and
 * is therefore the most likely of these to end up somewhere it should not, so being
 * greppable in a log or an access record is the point rather than a convenience.
 */
export const ONBOARDING_TOKEN_PREFIX = 'renkei_ob_';
export const CSRF_TOKEN_PREFIX = 'renkei_cf_';

const SECRET_BYTES = 32;

export function generateSecret(prefix: string): string {
  return prefix + randomBytes(SECRET_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * RFC 7636 verifier: 43–128 characters from the unreserved set. Checked
 * because a client that sends something shorter has weakened the exchange, and
 * silently accepting it would hide that.
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Base64url with no padding — what a correctly-built S256 challenge looks like. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE_PATTERN.test(challenge);
}

/**
 * Verifies an S256 challenge. `plain` is not implemented at all — OAuth 2.1
 * and the MCP authorization spec both require S256, and a `plain` fallback is
 * exactly the downgrade PKCE exists to prevent.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!VERIFIER_PATTERN.test(verifier)) {
    return false;
  }

  const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return constantTimeEquals(computed, challenge);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.byteLength !== right.byteLength) {
    return false;
  }

  return timingSafeEqual(left, right);
}
