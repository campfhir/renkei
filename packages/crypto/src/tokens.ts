/**
 * Bearer-credential primitives, promoted from apps/web/lib/mcp-token.ts
 * when the agents worker needed to mint run tokens — the two processes
 * must digest identically or a minted token verifies nowhere.
 *
 * `sha256Hex` is for credentials that are never read back: the server
 * issues the value once and thereafter only checks a presented one against
 * the digest, so a read of the table yields nothing usable (migration 011).
 * `generateSecret` is a CSPRNG — Math.random-derived tokens were once
 * predictable enough to recover (see mcp-token.ts history).
 */

import { createHash, randomBytes } from 'node:crypto';

/** Digest a bearer credential for storage. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Generate a bearer token, refresh token, client secret, or API key. */
export function generateSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}
