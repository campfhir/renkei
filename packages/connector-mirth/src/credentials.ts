/**
 * A person's Mirth credential for one instance, sealed at rest with the
 * deployment key. One credential per (instance, person) — the Mirth user
 * IS the identity the server authorizes, so what a person can do is exactly
 * what their own Mirth account can do. Parsing fails closed: a malformed
 * stored value means the connection is unusable until the person
 * reconnects, never a guess at what was meant.
 */

export interface MirthCredentials {
  username: string;
  password: string;
}

export type CredentialError = 'DECRYPTION_ERROR' | 'MALFORMED_CREDENTIALS';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted value into a credential, or null. Exposed for the
 * Mirth worker's test-connection endpoint, which receives a person's
 * unsaved credentials over the internal HTTP seam and must re-validate
 * them at the trust boundary rather than assume the caller's parsing.
 */
export function parseMirthCredentials(value: unknown): MirthCredentials | null {
  if (!isRecord(value)) return null;
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!username || !password) return null;
  return { username, password };
}
