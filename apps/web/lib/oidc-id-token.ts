/**
 * id_token claim validation for the OIDC callback.
 *
 * The token arrives over the TLS back-channel (server-to-server from the token
 * endpoint), so signature verification is defense-in-depth rather than the only
 * line — RFC 8725 permits omitting it there. What these checks add is the part
 * the back-channel does not give you: that the token was minted for THIS client
 * (aud/azp), by the configured issuer (iss), for THIS sign-in attempt (nonce),
 * and has not expired (exp). Without them a token the same IdP issued for a
 * different client, or a replayed older token, would be accepted.
 *
 * Returns null when every checked claim is valid, or a short reason string for
 * logging when one fails. The caller turns any non-null into a 400.
 */

export interface ExpectedIdTokenClaims {
  issuer: string;
  clientId: string;
  nonce: string;
}

/** Small leeway (seconds) for exp, to tolerate minor clock skew between hosts. */
const CLOCK_SKEW_LEEWAY_SECONDS = 60;

export function verifyIdTokenClaims(
  decoded: Record<string, unknown> | null,
  expected: ExpectedIdTokenClaims,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string | null {
  if (!decoded) return 'id_token missing or undecodable';

  // nonce — binds the token to the sign-in that set it. Absent when the IdP
  // did not echo it, which for our flow is itself a failure.
  if (typeof decoded.nonce !== 'string') return 'id_token has no nonce';
  if (decoded.nonce !== expected.nonce) return 'nonce mismatch';

  // iss — must exactly equal the configured issuer (OIDC Core 3.1.3.7).
  if (typeof decoded.iss !== 'string') return 'id_token has no issuer';
  if (decoded.iss !== expected.issuer) return 'issuer mismatch';

  // aud — must contain this client id. When there is more than one audience,
  // OIDC requires an azp naming this client.
  const aud = decoded.aud;
  const audiences = Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : [];
  if (audiences.length === 0) return 'id_token has no audience';
  if (!audiences.includes(expected.clientId)) return 'audience does not include this client';
  if (audiences.length > 1) {
    if (typeof decoded.azp !== 'string' || decoded.azp !== expected.clientId) {
      return 'multiple audiences without matching azp';
    }
  }

  // exp — required, and must be in the future within a small skew allowance.
  if (typeof decoded.exp !== 'number') return 'id_token has no expiry';
  if (decoded.exp + CLOCK_SKEW_LEEWAY_SECONDS < nowSeconds) return 'id_token expired';

  return null;
}
