/**
 * What a dynamic client registration (RFC 7591) may say about itself,
 * judged the same way at both registration endpoints. The redirect URIs
 * carry the policy that matters (lib/oauth-redirect-uri.ts); the rest is
 * bounded so a registration cannot be a free-text store.
 */

import { redirectUriProblem } from './oauth-redirect-uri';

export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME_CHARS = 200;
const RESPONSE_TYPES = ['code'];
const GRANT_TYPES = ['authorization_code', 'refresh_token'];

export interface Registration {
  client_name: string | null;
  redirect_uris: string[];
  response_types: string[];
  grant_types: string[];
  token_endpoint_auth_method: unknown;
}

export interface RegistrationProblem {
  /** The RFC 7591 section 3.2.2 error code. */
  error: 'invalid_redirect_uri' | 'invalid_client_metadata';
  problem: string;
}

export function readRegistration(body: unknown): Registration | RegistrationProblem {
  if (!isRecord(body)) {
    return { error: 'invalid_client_metadata', problem: 'The registration must be a JSON object' };
  }
  const fields = body;

  const uris = stringList(fields.redirect_uris, []);
  if (!uris || uris.length === 0) {
    return {
      error: 'invalid_redirect_uri',
      problem: 'redirect_uris is required and must be a non-empty array',
    };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return {
      error: 'invalid_redirect_uri',
      problem: `redirect_uris may list at most ${MAX_REDIRECT_URIS} URIs`,
    };
  }
  for (const [index, uri] of uris.entries()) {
    const problem = redirectUriProblem(uri);
    if (problem) {
      return { error: 'invalid_redirect_uri', problem: `redirect_uris[${index}] ${problem}` };
    }
  }

  let clientName: string | null = null;
  if (fields.client_name !== undefined && fields.client_name !== null) {
    if (typeof fields.client_name !== 'string') {
      return { error: 'invalid_client_metadata', problem: 'client_name must be a string' };
    }
    // Shown on the consent page, so one line, trimmed, bounded.
    clientName = fields.client_name.replace(/\s+/g, ' ').trim().slice(0, MAX_CLIENT_NAME_CHARS);
    if (!clientName) clientName = null;
  }

  const responseTypes = stringList(fields.response_types, RESPONSE_TYPES);
  if (!responseTypes || responseTypes.some((type) => !RESPONSE_TYPES.includes(type))) {
    return { error: 'invalid_client_metadata', problem: 'response_types may only contain "code"' };
  }
  const grantTypes = stringList(fields.grant_types, GRANT_TYPES);
  if (!grantTypes || grantTypes.some((type) => !GRANT_TYPES.includes(type))) {
    return {
      error: 'invalid_client_metadata',
      problem: 'grant_types may only contain "authorization_code" and "refresh_token"',
    };
  }

  return {
    client_name: clientName,
    redirect_uris: uris,
    response_types: responseTypes,
    grant_types: grantTypes,
    token_endpoint_auth_method: fields.token_endpoint_auth_method,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** `fallback` when absent; null when present but not a list of strings. */
function stringList(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) return null;
  return value.every(isString) ? value : null;
}
