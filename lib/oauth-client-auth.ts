/**
 * Client authentication at the token endpoint (RFC 6749 section 2.3.1).
 *
 * Both token routes previously read `client_id` and `client_secret` only from
 * the request body, while dynamic client registration handed every client
 * `token_endpoint_auth_method: "client_secret_basic"` and the server metadata
 * advertised the same. A client that did as it was told sent an
 * `Authorization: Basic` header, the body carried no credentials, and the
 * exchange failed with `invalid_request` — which is what MCP clients surfaced
 * as "token exchange failed" after registering successfully.
 */

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  /** How the client presented them, for logging and metadata echo. */
  method: 'client_secret_basic' | 'client_secret_post';
}

/**
 * Decode an `Authorization: Basic` header into a client id and secret.
 *
 * RFC 6749 requires each half to be form-urlencoded before base64, so they are
 * decoded on the way out. Returns null for anything malformed rather than
 * guessing: a caller that cannot be identified is not authenticated.
 */
function fromBasicHeader(header: string | null): ClientCredentials | null {
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic') return null;

  const encoded = rest.join(' ').trim();
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }

  // Split on the first colon only: a secret may legitimately contain one.
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;

  try {
    const clientId = decodeURIComponent(decoded.slice(0, separator));
    const clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret, method: 'client_secret_basic' };
  } catch {
    // decodeURIComponent throws on a stray '%'. Some clients do not encode at
    // all, so fall back to the raw halves rather than rejecting them.
    const clientId = decoded.slice(0, separator);
    const clientSecret = decoded.slice(separator + 1);
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret, method: 'client_secret_basic' };
  }
}

/**
 * Resolve client credentials from a token request, accepting either the
 * `Authorization: Basic` header or `client_id`/`client_secret` in the body.
 *
 * The header wins when both are present, matching the precedence RFC 6749
 * gives it.
 */
export function readClientCredentials(
  authorizationHeader: string | null,
  body: Record<string, string>
): ClientCredentials | null {
  const basic = fromBasicHeader(authorizationHeader);
  if (basic) return basic;

  if (body.client_id && body.client_secret) {
    return {
      clientId: body.client_id,
      clientSecret: body.client_secret,
      method: 'client_secret_post',
    };
  }

  return null;
}

/** Auth methods the token endpoint accepts, as advertised in server metadata. */
export const SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS = [
  'client_secret_basic',
  'client_secret_post',
] as const;
