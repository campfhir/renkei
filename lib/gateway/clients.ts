/**
 * Client registration (RFC 7591) and redirect-URI validation.
 *
 * Redirect-URI matching is the single most security-relevant comparison in
 * this file, and it is deliberately the dumbest one: exact string equality
 * against the registered list. No prefix matching, no wildcard, no
 * "same-origin is close enough". Every well-known authorization-code
 * interception starts with a redirect matcher that was cleverer than that.
 */

import type { GatewayStore, OAuthClient } from './store.js';
import { formatScope, parseScope, resolveScopes } from './scopes.js';
import { CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX, generateSecret, hashToken } from './tokens.js';

export class RegistrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Accepts the three shapes a legitimate MCP client redirects to:
 *
 *   - `https://…` — hosted clients such as Claude.ai
 *   - `http://` on loopback — the local-port pattern RFC 8252 defines for
 *     native apps, and the only case where cleartext is acceptable because the
 *     request never leaves the machine
 *   - a private-use scheme such as `vscode://…` — how IDE agents receive the
 *     redirect; RFC 8252 §7.1 recommends exactly this for native clients
 *
 * Plain `http` to anywhere else is refused. An authorization code delivered
 * over cleartext to a remote host is readable by anything on the path.
 */
export function assertUsableRedirectUri(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RegistrationError('invalid_redirect_uri', `${raw} is not an absolute URI`);
  }

  if (url.hash !== '') {
    // RFC 6749 §3.1.2: the endpoint URI must not include a fragment, because
    // the fragment is where the response would be appended.
    throw new RegistrationError('invalid_redirect_uri', `${raw} must not contain a fragment`);
  }

  if (url.protocol === 'https:') return;

  if (url.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(url.hostname)) return;
    throw new RegistrationError(
      'invalid_redirect_uri',
      `${raw} uses http to a non-loopback host. Use https, or http on localhost.`,
    );
  }

  // A private-use scheme, e.g. vscode:// — nothing further to check, the OS
  // decides who receives it.
  if (/^[a-z][a-z0-9+.-]*:$/i.test(url.protocol)) return;

  throw new RegistrationError('invalid_redirect_uri', `${raw} has an unusable scheme`);
}

/** Exact match. Deliberately not clever — see the file header. */
export function isRegisteredRedirectUri(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

export interface RegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}

export interface RegistrationResult {
  client: OAuthClient;
  /** The plaintext secret, returned once and never recoverable. */
  secret: string | null;
  /** RFC 7591 registration response body. */
  body: Record<string, unknown>;
}

const MAX_REDIRECT_URIS = 10;

/**
 * Registers a client.
 *
 * Open registration is worth stating plainly: with DCR on, anyone who can
 * reach the endpoint can create a client. That is by design — it is what lets
 * Claude.ai self-register — and it is acceptable because a client on its own
 * can do nothing. Every capability arrives only after a *human* completes
 * Atlassian sign-in and consent, and then only within that human's own Jira
 * permissions. What registration grants is the right to ask; the Atlassian
 * consent screen is what grants access.
 *
 * Deployments that would rather not accept that trade set ENABLE_DCR=false and
 * pre-register clients.
 */
export async function registerClient(
  store: GatewayStore,
  request: RegistrationRequest,
  options: { readOnly: boolean; now: () => Date },
): Promise<RegistrationResult> {
  const redirectUris = Array.isArray(request.redirect_uris)
    ? request.redirect_uris.filter((entry): entry is string => typeof entry === 'string')
    : [];

  if (redirectUris.length === 0) {
    throw new RegistrationError('invalid_redirect_uri', 'redirect_uris is required');
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    throw new RegistrationError(
      'invalid_client_metadata',
      `at most ${MAX_REDIRECT_URIS} redirect URIs`,
    );
  }
  for (const uri of redirectUris) {
    assertUsableRedirectUri(uri);
  }

  const authMethod =
    typeof request.token_endpoint_auth_method === 'string'
      ? request.token_endpoint_auth_method
      : 'client_secret_basic';

  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(authMethod)) {
    throw new RegistrationError(
      'invalid_client_metadata',
      `token_endpoint_auth_method ${authMethod} is not supported`,
    );
  }

  const grantTypes = Array.isArray(request.grant_types)
    ? request.grant_types.map(String)
    : ['authorization_code', 'refresh_token'];

  for (const grant of grantTypes) {
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      throw new RegistrationError(
        'invalid_client_metadata',
        `grant type ${grant} is not supported`,
      );
    }
  }

  const { granted } = resolveScopes(
    parseScope(typeof request.scope === 'string' ? request.scope : null),
    options.readOnly,
  );

  const secret = authMethod === 'none' ? null : generateSecret(CLIENT_SECRET_PREFIX);
  const now = options.now().toISOString();

  const client: OAuthClient = {
    clientId: generateSecret(CLIENT_ID_PREFIX),
    clientName:
      typeof request.client_name === 'string' && request.client_name.trim() !== ''
        ? request.client_name.slice(0, 200)
        : 'Unnamed MCP client',
    redirectUris,
    secretHash: secret === null ? null : hashToken(secret),
    scope: granted,
    createdAt: now,
  };

  await store.createClient(client);

  return {
    client,
    secret,
    body: {
      client_id: client.clientId,
      ...(secret === null ? {} : { client_secret: secret }),
      client_id_issued_at: Math.floor(Date.parse(now) / 1000),
      // Secrets do not expire on their own. Rotation is a re-registration.
      ...(secret === null ? {} : { client_secret_expires_at: 0 }),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      scope: formatScope(client.scope),
    },
  };
}

/**
 * Confirms a client is who it says it is at the token endpoint.
 *
 * A public client (no registered secret) presents none, and PKCE is what
 * authenticates the exchange instead. A confidential client must present the
 * right one — and a *missing* secret from a client that has one registered is
 * a failure, not a downgrade to the public path.
 */
export function verifyClientSecret(client: OAuthClient, presented: string | null): boolean {
  if (client.secretHash === null) {
    return presented === null;
  }
  if (presented === null) {
    return false;
  }
  return hashToken(presented) === client.secretHash;
}
