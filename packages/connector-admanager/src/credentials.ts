/**
 * A person's ADManager Plus credential for one instance, sealed at rest
 * with the deployment key. One credential per (instance, person) — the
 * authtoken IS the identity ADManager Plus authorizes (via the token's
 * own scope and the technician account it was generated for), so what a
 * person can do is exactly what their own token can. Unlike Mirth's
 * username/password, this is a single bearer token with no session to
 * establish: it travels as the Authorization header on every request.
 * Parsing fails closed: a malformed stored value means the connection is
 * unusable until the person reconnects, never a guess at what was meant.
 */

export interface AdManagerCredentials {
  authToken: string;
}

export type CredentialError = 'DECRYPTION_ERROR' | 'MALFORMED_CREDENTIALS';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted value into a credential, or null. Exposed for the
 * ADManager Plus worker's test-connection endpoint, which receives a
 * person's unsaved credentials over the internal HTTP seam and must
 * re-validate them at the trust boundary rather than assume the caller's
 * parsing.
 */
export function parseAdManagerCredentials(value: unknown): AdManagerCredentials | null {
  if (!isRecord(value)) return null;
  const authToken = typeof value.authToken === 'string' ? value.authToken.trim() : '';
  if (!authToken) return null;
  return { authToken };
}
