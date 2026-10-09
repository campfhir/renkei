/**
 * The one-time onboarding secret (migration 146): minted when a tenant is
 * created, shown once to the person who created it, and required by the
 * first — unauthenticated — identity-provider configuration
 * (api/tenant/[tenantId]/oidc).
 *
 * Before it, that first configuration was open to anyone holding the tenant
 * id, and the id travelled in the creator's browser URL and in the create
 * response. Whoever posted an IdP first owned the tenant. Now the creator
 * holds something nobody else saw. Only the digest is stored, the same
 * reasoning as every other bearer credential here (lib/mcp-token.ts), and
 * the secret dies on use or after a day, whichever comes first.
 */

import { generateSecret, sha256Hex } from '@renkei/crypto';
import { digestsMatch } from '@/lib/mcp-token';

export const BOOTSTRAP_SECRET_HEADER = 'x-renkei-bootstrap-secret';
export const BOOTSTRAP_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

export interface MintedBootstrapSecret {
  /** Shown to the creator once; never stored. */
  secret: string;
  /** What the tenants row keeps. */
  hash: string;
  expiresAt: Date;
}

export function mintBootstrapSecret(now: Date = new Date()): MintedBootstrapSecret {
  const secret = generateSecret(32);
  return {
    secret,
    hash: sha256Hex(secret),
    expiresAt: new Date(now.getTime() + BOOTSTRAP_SECRET_TTL_MS),
  };
}

export type BootstrapVerdict = 'ok' | 'missing' | 'expired' | 'mismatch' | 'none-issued';

/**
 * Whether a presented secret is the live one for a tenant row. A row with
 * no digest never had one (it predates migration 146) or already spent it;
 * nothing presented can match, and the caller says so distinctly so an
 * operator knows the fix is on the database side.
 */
export function verifyBootstrapSecret(
  presented: string | null | undefined,
  row: { bootstrap_secret_hash: string | null; bootstrap_secret_expires_at: Date | string | null },
  now: Date = new Date()
): BootstrapVerdict {
  if (!row.bootstrap_secret_hash) return 'none-issued';
  if (!presented) return 'missing';
  if (!row.bootstrap_secret_expires_at || new Date(row.bootstrap_secret_expires_at) < now) {
    return 'expired';
  }
  return digestsMatch(row.bootstrap_secret_hash, sha256Hex(presented)) ? 'ok' : 'mismatch';
}
