/**
 * PKCE (RFC 7636), required of every MCP client. The authorization code
 * travels through the person's browser and the client's redirect URI; the
 * verifier never does, so a code lifted in transit cannot be exchanged
 * without it. Only `S256` is accepted: `plain` sends the verifier itself
 * as the challenge and protects nothing.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** The only transform accepted; advertised as such in server metadata. */
export const CODE_CHALLENGE_METHODS = ['S256'] as const;

/** 32 bytes, base64url without padding (RFC 7636 section 4.2). */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** 43 to 128 unreserved characters (RFC 7636 section 4.1). */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Why an authorization request's PKCE parameters are unacceptable, or null
 * when they are a well-formed S256 challenge.
 */
export function codeChallengeProblem(
  challenge: string | null,
  method: string | null
): string | null {
  if (!challenge) return 'code_challenge is required (PKCE, RFC 7636)';
  if (method !== 'S256') return 'code_challenge_method must be S256';
  if (!CHALLENGE.test(challenge)) {
    return 'code_challenge must be the base64url SHA-256 of the verifier, 43 characters';
  }
  return null;
}

export function isWellFormedVerifier(verifier: string | undefined): verifier is string {
  return typeof verifier === 'string' && VERIFIER.test(verifier);
}

export function computeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** Whether `verifier` is the one `challenge` committed to, compared in constant time. */
export function verifierMatchesChallenge(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(computeS256(verifier));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
