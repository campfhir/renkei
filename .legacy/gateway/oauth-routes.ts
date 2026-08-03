/**
 * Renkei's OAuth 2.1 authorization server.
 *
 * Renkei sits between two authorization flows and is a different role in
 * each. To the MCP client it is the authorization server; to Atlassian it is a
 * confidential client. The two legs are deliberately not the same protocol:
 *
 *   MCP client → Renkei   OAuth 2.1, PKCE S256 required, no exceptions
 *   Renkei → Atlassian    plain confidential-client code exchange, because
 *                           Atlassian 3LO does not publicly support PKCE
 *                           (ECO-283, see README § Authentication flow)
 *
 * The Atlassian tokens never cross back to the MCP client. What the client
 * receives is a Renkei token that resolves, server-side, to a user whose
 * Atlassian grant is held encrypted in the database.
 *
 * Two rules govern every error path here:
 *
 *   1. Nothing is redirected to an unvalidated redirect_uri. Until the client
 *      and its redirect URI are both confirmed, errors render as HTML at
 *      Renkei's own origin. Redirecting first is how an open redirector is
 *      built.
 *   2. Nothing echoes a secret. Error descriptions name the parameter, never
 *      its value.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildAuthorizeUrl, type FetchLike } from '../auth/atlassian.js';
import { completeAtlassianAuthorization } from '../auth/grant.js';
import { AtlassianAuthError } from '../auth/atlassian.js';
import type { AtlassianConfig, Config } from '../config.js';
import { errorPage } from '../ui/render.js';
import {
  isRegisteredRedirectUri,
  registerClient,
  RegistrationError,
  verifyClientSecret,
} from './clients.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  parseResourceUrl,
} from './metadata.js';
import { completePortalSignIn } from './portal-routes.js';
import { formatScope, parseScope, resolveScopes } from './scopes.js';
import type { GatewayStore, OAuthClient, PendingMcpReauth, Session } from './store.js';
import {
  ACCESS_TOKEN_PREFIX,
  AUTHORIZATION_CODE_PREFIX,
  REFRESH_TOKEN_PREFIX,
  generateSecret,
  hashToken,
  isValidCodeChallenge,
  verifyPkce,
} from './tokens.js';
import { queryStrings } from './request-input.js';

export interface OAuthDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

/** Long enough for a browser round trip, short enough to be uninteresting. */
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

function noStore(reply: FastifyReply): FastifyReply {
  // RFC 6749 §5.1 — token responses must not be cached anywhere.
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return noStore(reply).code(status).send({ error, error_description: description });
}

/** Adds the OAuth error parameters to an already-validated redirect URI. */
function redirectWithError(
  reply: FastifyReply,
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): FastifyReply {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== null) {
    url.searchParams.set('state', state);
  }
  return reply.redirect(url.toString(), 302);
}

/**
 * Reads client credentials from either RFC 6749 location.
 *
 * `client_secret_basic` is the spec's SHOULD and what most clients send;
 * `client_secret_post` is common enough that refusing it breaks real clients.
 * A public client sends neither and is identified by the `client_id` body
 * parameter alone.
 */
function readClientCredentials(
  request: FastifyRequest,
  body: Record<string, string>,
): { clientId: string | null; secret: string | null } {
  const header = request.headers.authorization;

  if (typeof header === 'string' && header.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator > 0) {
      return {
        // RFC 6749 §2.3.1 form-encodes both halves.
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        secret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    }
  }

  return {
    clientId: body.client_id ?? null,
    secret: body.client_secret ?? null,
  };
}

async function completeMcpReauth(
  deps: OAuthDeps,
  pending: PendingMcpReauth,
  query: Record<string, string | undefined>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { config, store, now, fetchImpl } = deps;

  const code = query.code ?? '';
  const error = query.error ?? null;

  if (error !== null) {
    return reply
      .code(400)
      .type('text/html; charset=utf-8')
      .send(
        errorPage(
          'Authorization failed',
          `Atlassian refused the authorization: ${error}. Please try again.`,
        ),
      );
  }

  if (code === '') {
    return reply
      .code(400)
      .type('text/html; charset=utf-8')
      .send(
        errorPage(
          'Missing authorization code',
          'Atlassian did not return an authorization code. Please try again.',
        ),
      );
  }

  try {
    const sessionId = pending.sessionId;

    // Look up the session to get its tenant and Atlassian app config
    const session = await store.findSessionById(sessionId);
    if (!session) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(errorPage('Session not found', 'The session for this re-auth is no longer valid.'));
    }

    const tenant = await store.resolveEndpoint(session.tenantSiteId);
    if (!tenant) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage('Tenant not found', 'The tenant for this session is unknown or suspended.'),
        );
    }

    const scoped = store.forTenant(tenant);

    // Parse the stored OAuth client info from the pending authorization
    let reachState: {
      accountId: string;
      atlassianClientId: string;
      atlassianClientSecret: string;
    };
    try {
      const clientStateJson = pending.clientState ?? '{}';
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-explicit-any
      const parsed: any = JSON.parse(clientStateJson);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'accountId' in parsed &&
        'atlassianClientId' in parsed &&
        'atlassianClientSecret' in parsed &&
        typeof (parsed as Record<string, unknown>).accountId === 'string' &&
        typeof (parsed as Record<string, unknown>).atlassianClientId === 'string' &&
        typeof (parsed as Record<string, unknown>).atlassianClientSecret === 'string'
      ) {
        reachState = {
          accountId: (parsed as Record<string, unknown>).accountId as string,
          atlassianClientId: (parsed as Record<string, unknown>).atlassianClientId as string,
          atlassianClientSecret: (parsed as Record<string, unknown>)
            .atlassianClientSecret as string,
        };
      } else {
        throw new Error('Invalid state object');
      }
    } catch {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage('Invalid state', 'The re-authentication state is corrupted. Please try again.'),
        );
    }

    const grant = await scoped.getGrant(reachState.accountId);
    if (!grant) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Grant not found',
            'The Jira grant for this session no longer exists. Please sign in again.',
          ),
        );
    }

    // Rebuild the Atlassian config using the original OAuth client credentials
    if (!reachState.atlassianClientSecret) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Invalid state',
            'The re-authentication state does not contain valid OAuth credentials. Please try again.',
          ),
        );
    }

    const atlassian: AtlassianConfig = {
      ...config.atlassian,
      cloudId: grant.cloudId,
      clientId: reachState.atlassianClientId,
      clientSecret: reachState.atlassianClientSecret,
    };

    // Exchange the code for a grant with Atlassian
    await completeAtlassianAuthorization(atlassian, code, { fetchImpl, now });

    return reply
      .type('text/html; charset=utf-8')
      .send(
        errorPage(
          'Re-authentication successful',
          'Your Jira token has been refreshed. You can now close this window and retry your MCP operation.',
        ),
      );
  } catch (error: unknown) {
    const message =
      error instanceof AtlassianAuthError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Unknown error';
    return reply
      .code(400)
      .type('text/html; charset=utf-8')
      .send(
        errorPage(
          'Token exchange failed',
          `Failed to exchange the authorization code: ${message}. Please try again.`,
        ),
      );
  }
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthDeps): void {
  const { config, store, now, fetchImpl } = deps;

  interface Target {
    /** Scoped to the tenant that owns the resource. */
    store: GatewayStore;
    /** The tenant's own Atlassian app, or the deployment's. */
    atlassian: AtlassianConfig;
  }

  /**
   * Turns an RFC 8707 `resource` into the tenant that owns it.
   *
   * Null means "not served here" — unknown endpoint, malformed URL, a
   * suspended tenant, or no resource at all, all one answer. There is no more
   * "the configured tenant" to fall back to for a missing or bare-`/mcp`
   * resource: every tenant mints its endpoint through the self-service wizard
   * or `pnpm tenant claim-site`, so a caller that names none is unresolvable
   * rather than defaulted.
   */
  async function resolveTarget(resource: string | null): Promise<Target | null> {
    if (resource === null) return null;

    const parsed = parseResourceUrl(config.publicBaseUrl, resource);
    if (parsed === undefined || parsed.tenantSiteId === null) return null;

    const tenant = await store.resolveEndpoint(parsed.tenantSiteId);
    if (tenant === null) return null;

    const scoped = store.forTenant(tenant);
    return { store: scoped, atlassian: atlassianFor(scoped) };
  }

  /**
   * The Atlassian app to broker through, and the site to pin the result to.
   *
   * The redirect URI is the deployment's either way, because it is Renkei's
   * callback rather than the tenant's.
   *
   * `cloudId` comes from the resolved site rather than from `ATLASSIAN_CLOUD_ID`.
   * That distinction is invisible on a single-tenant deployment, where they are
   * the same value, and load-bearing the moment a second site is registered: the
   * callback pins the returned grant against this, so leaving the configured one
   * in place would refuse every authorization for any site but the first.
   */
  function atlassianFor(scoped: GatewayStore): AtlassianConfig {
    return {
      ...config.atlassian,
      cloudId: scoped.tenant.cloudId,
    };
  }
  const metadataOptions = {
    publicBaseUrl: config.publicBaseUrl,
    readOnly: config.readOnly,
    enableDcr: config.enableDcr,
  };

  // ------------------------------------------------------------- discovery

  const protectedResource = (tenantSiteId?: string) =>
    protectedResourceMetadata(
      tenantSiteId === undefined ? metadataOptions : { ...metadataOptions, tenantSiteId },
    );

  app.get('/.well-known/oauth-protected-resource', () => protectedResource());
  // MCP clients derive this path from the resource URL's path component, so
  // /mcp's metadata is also served at the suffixed location.
  app.get('/.well-known/oauth-protected-resource/mcp', () => protectedResource());

  /**
   * Per-endpoint discovery. Answered for any well-formed site ID, including
   * ones that do not exist: the document is the same shape either way, and
   * refusing here would turn discovery into an endpoint oracle for anyone who
   * can make an unauthenticated GET. Whether the endpoint is real is settled
   * at /oauth/authorize, which needs a registered client.
   */
  app.get('/.well-known/oauth-protected-resource/mcp/:tenantSiteId', (request) => {
    const { tenantSiteId } = request.params as { tenantSiteId: string };
    return protectedResource(tenantSiteId);
  });

  app.get('/.well-known/oauth-authorization-server', () =>
    authorizationServerMetadata(metadataOptions),
  );
  // Some clients probe the OIDC path even for a plain OAuth server.
  app.get('/.well-known/oauth-authorization-server/mcp', () =>
    authorizationServerMetadata(metadataOptions),
  );

  // ---------------------------------------------------------- registration

  app.post('/oauth/register', async (request, reply) => {
    if (!config.enableDcr) {
      return oauthError(
        reply,
        404,
        'invalid_request',
        'Dynamic client registration is disabled on this deployment. Ask the operator to ' +
          'pre-register this client.',
      );
    }

    try {
      const result = await registerClient(store, request.body ?? {}, {
        readOnly: config.readOnly,
        now,
      });
      // 201 with the secret in the body — the only time it is ever returned.
      return noStore(reply).code(201).send(result.body);
    } catch (error) {
      if (error instanceof RegistrationError) {
        return oauthError(reply, 400, error.code, error.message);
      }
      throw error;
    }
  });

  // ------------------------------------------------------------- authorize

  app.get('/oauth/authorize', async (request, reply) => {
    const query = queryStrings(request);

    const clientId = query.client_id ?? '';
    const redirectUri = query.redirect_uri ?? '';
    const state = query.state ?? null;

    // --- Phase 1: everything that must NOT redirect ---------------------
    //
    // Until both the client and the redirect URI check out, an error response
    // stays on Renkei's origin. Redirecting an unvalidated URI would make
    // this endpoint a general-purpose redirector.

    const client = clientId === '' ? null : await store.findClient(clientId);

    if (!client) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Unknown client',
            'This MCP client is not registered with this Renkei deployment. If registration ' +
              'is disabled here, an operator has to add it by hand.',
          ),
        );
    }

    if (redirectUri === '' || !isRegisteredRedirectUri(client, redirectUri)) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Redirect URI mismatch',
            'The redirect_uri does not exactly match one registered for this client. Renkei ' +
              'compares them character for character and will not guess.',
          ),
        );
    }

    // --- Phase 2: errors the client can be told about --------------------

    if ((query.response_type ?? '') !== 'code') {
      return redirectWithError(
        reply,
        redirectUri,
        'unsupported_response_type',
        'Only the authorization code flow is supported.',
        state,
      );
    }

    const challenge = query.code_challenge ?? '';
    const challengeMethod = query.code_challenge_method ?? '';

    if (challenge === '') {
      return redirectWithError(
        reply,
        redirectUri,
        'invalid_request',
        'code_challenge is required. This server does not issue codes without PKCE.',
        state,
      );
    }
    if (challengeMethod !== 'S256') {
      return redirectWithError(
        reply,
        redirectUri,
        'invalid_request',
        'code_challenge_method must be S256; plain is not accepted.',
        state,
      );
    }
    if (!isValidCodeChallenge(challenge)) {
      return redirectWithError(
        reply,
        redirectUri,
        'invalid_request',
        'code_challenge is not a base64url-encoded SHA-256 digest.',
        state,
      );
    }

    const { granted, refused } = resolveScopes(parseScope(query.scope), config.readOnly);

    if (refused.length > 0) {
      return redirectWithError(
        reply,
        redirectUri,
        'invalid_scope',
        `This deployment does not grant: ${refused.join(', ')}.` +
          (config.readOnly ? ' It is running in read-only mode.' : ''),
        state,
      );
    }
    if (granted.length === 0) {
      return redirectWithError(reply, redirectUri, 'invalid_scope', 'No usable scope.', state);
    }

    // RFC 8707. Recorded so a token minted for this resource is not accepted
    // by some other one later, and used here to pick the tenant — and therefore
    // the Atlassian app — this authorization belongs to.
    const resource = query.resource ?? null;
    const target = await resolveTarget(resource);

    if (target === null) {
      // Unknown and malformed collapse into one answer. It is the honest limit
      // of the anti-enumeration property: choosing an upstream app requires
      // knowing the tenant, so unlike /mcp this endpoint cannot avoid telling a
      // caller with a registered client whether an endpoint exists. Endpoint
      // IDs are unguessable UUIDs and DCR can be turned off; the difference is
      // not papered over with a fake redirect.
      return redirectWithError(
        reply,
        redirectUri,
        'invalid_target',
        'That resource is not served here.',
        state,
      );
    }

    // --- Phase 3: hand off to Atlassian ----------------------------------
    //
    // brokerState is the only thing tying the eventual callback to this
    // request. It is a fresh secret, never the client's own state, so a client
    // cannot influence what comes back.
    const brokerState = generateSecret('');

    await store.putPendingAuthorization({
      kind: 'mcp',
      brokerState,
      clientId: client.clientId,
      redirectUri,
      clientState: state,
      codeChallenge: challenge,
      scope: granted,
      resource,
      expiresAt: new Date(now().getTime() + PENDING_AUTHORIZATION_TTL_MS).toISOString(),
    });

    return reply.redirect(buildAuthorizeUrl(target.atlassian, brokerState), 302);
  });

  // -------------------------------------------------------------- callback

  app.get('/oauth/callback', async (request, reply) => {
    const query = queryStrings(request);
    const brokerState = query.state ?? '';

    // Single use. An unrecognized state is an unsolicited callback, and there
    // is nowhere legitimate to redirect it to — so it dies here.
    const pending = brokerState === '' ? null : await store.takePendingAuthorization(brokerState);

    if (!pending) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Nothing to complete',
            'This sign-in link has already been used, has expired, or did not originate here. ' +
              'Start the connection again from your MCP client.',
          ),
        );
    }

    /**
     * A portal sign-in comes back here too, and means something different: there
     * is no client waiting for a code, so it renders a page and sets a cookie
     * instead of redirecting. Branching on server-side state rather than on
     * anything in the request is what keeps a caller from choosing which of the
     * two it lands in.
     *
     * Everything below this narrows to the MCP flow, so the compiler enforces
     * that a redirect is only built from a row that has somewhere to redirect.
     */
    if (pending.kind === 'portal') {
      return completePortalSignIn(
        { config, store, now, fetchImpl },
        pending,
        query,
        request,
        reply,
      );
    }

    if (pending.kind === 'mcp_reauth') {
      return completeMcpReauth({ config, store, now, fetchImpl }, pending, query, reply);
    }

    // Everything below narrows to MCP authorization flow
    if (Date.parse(pending.expiresAt) <= now().getTime()) {
      return redirectWithError(
        reply,
        pending.redirectUri,
        'access_denied',
        'The sign-in took too long. Please try again.',
        pending.clientState,
      );
    }

    const atlassianError = query.error;
    if (atlassianError !== undefined) {
      // The user declined, or Atlassian refused. Pass it through rather than
      // inventing a reason.
      return redirectWithError(
        reply,
        pending.redirectUri,
        'access_denied',
        `Atlassian returned ${atlassianError}.`,
        pending.clientState,
      );
    }

    const code = query.code ?? '';
    if (code === '') {
      return redirectWithError(
        reply,
        pending.redirectUri,
        'server_error',
        'Atlassian did not return an authorization code.',
        pending.clientState,
      );
    }

    // The pending row carries the resource this flow was started for, so the
    // callback lands on the same tenant the authorize request resolved to.
    // Re-resolving rather than trusting a stashed tenant id keeps a suspended
    // tenant from completing a flow that began while it was active.
    const tenantTarget = await resolveTarget(pending.resource);
    if (tenantTarget === null) {
      return redirectWithError(
        reply,
        pending.redirectUri,
        'invalid_target',
        'That resource is no longer served here.',
        pending.clientState,
      );
    }

    const scoped = tenantTarget.store;

    let completed;
    try {
      completed = await completeAtlassianAuthorization(tenantTarget.atlassian, code, {
        now,
        fetchImpl,
      });
    } catch (error) {
      // Site pinning failures land here, and they are worth surfacing as
      // themselves: the user signed in successfully, to the wrong tenant.
      const description =
        error instanceof AtlassianAuthError && error.status === 403
          ? 'Your Atlassian account does not have access to the site this deployment serves.'
          : 'Could not complete the Atlassian authorization.';

      request.log.warn({ err: error }, 'atlassian authorization failed');
      return redirectWithError(
        reply,
        pending.redirectUri,
        'access_denied',
        description,
        pending.clientState,
      );
    }

    const { grant } = completed;

    // The user row must exist before the grant, which references it.
    await scoped.upsertUser(grant.accountId, grant.displayName);
    await scoped.putGrant(grant);

    // Links this account to this tenant's site, which is what a session then
    // points at and what makes the person a user of the tenant. Derived from
    // reaching the endpoint and consenting, rather than from an invitation.
    await scoped.linkSite(grant.accountId);

    const authorizationCode = generateSecret(AUTHORIZATION_CODE_PREFIX);

    await store.putAuthorizationCode({
      codeHash: hashToken(authorizationCode),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      accountId: grant.accountId,
      scope: pending.scope,
      resource: pending.resource,
      expiresAt: new Date(
        now().getTime() + config.authorizationCodeTtlSeconds * 1000,
      ).toISOString(),
      redeemedSessionId: null,
    });

    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', authorizationCode);
    if (pending.clientState !== null) {
      target.searchParams.set('state', pending.clientState);
    }
    // RFC 9207: lets the client confirm which authorization server answered.
    target.searchParams.set('iss', config.publicBaseUrl.replace(/\/+$/, ''));

    return reply.redirect(target.toString(), 302);
  });

  // ----------------------------------------------------------------- token

  app.post('/oauth/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const { clientId, secret } = readClientCredentials(request, body);

    if (clientId === null || clientId === '') {
      return oauthError(reply, 401, 'invalid_client', 'No client_id was presented.');
    }

    const client = await store.findClient(clientId);
    if (!client || !verifyClientSecret(client, secret)) {
      // Same response for "no such client" and "wrong secret" — the difference
      // is not the caller's business.
      return oauthError(reply, 401, 'invalid_client', 'Client authentication failed.');
    }

    switch (body.grant_type) {
      case 'authorization_code':
        return exchangeCode(reply, client, body);
      case 'refresh_token':
        return refresh(reply, client, body);
      default:
        return oauthError(
          reply,
          400,
          'unsupported_grant_type',
          'Supported grant types are authorization_code and refresh_token.',
        );
    }
  });

  async function exchangeCode(
    reply: FastifyReply,
    client: OAuthClient,
    body: Record<string, string>,
  ): Promise<FastifyReply> {
    const code = body.code ?? '';
    const verifier = body.code_verifier ?? '';

    if (code === '' || verifier === '') {
      return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are both required.');
    }

    const sessionId = randomUUID();
    const record = await store.redeemAuthorizationCode(hashToken(code), sessionId);

    if (!record) {
      return oauthError(reply, 400, 'invalid_grant', 'Unknown or expired authorization code.');
    }

    if (record.redeemedSessionId !== null) {
      /**
       * A second presentation of the same code. Two very different things look
       * like this from here, and PKCE is what tells them apart.
       *
       * A code can leak — from a redirect, a proxy log, a referrer — and RFC 6749
       * §4.1.2 says to assume exactly that and revoke whatever the code produced.
       * It says SHOULD rather than MUST, and it predates PKCE. A caller that
       * presents the matching `code_verifier` has demonstrated possession of the
       * secret behind the challenge, and that secret does not travel before this
       * request: that is the client which started the flow, redeeming twice, not
       * somebody exercising a code they intercepted.
       *
       * Revoking in that case is collateral damage, and not a hypothetical one —
       * `mcp-remote` fires two exchanges concurrently for one code, so the strict
       * reading makes a widely used client unable to connect at all. Since this
       * server refuses to issue a code without S256 PKCE, a leaked code on its own
       * is not redeemable, which is the protection §4.1.2 was reaching for.
       *
       * So: a replay that cannot prove it owns the flow is treated as a leak and
       * the session dies. One that can is refused — the code stays single-use —
       * and the session it already created is left working.
       */
      const ownsFlow =
        record.clientId === client.clientId && verifyPkce(verifier, record.codeChallenge);

      if (!ownsFlow) {
        // Best-effort by construction: the winning exchange creates its session
        // after claiming the code, so a replay racing it inside that window
        // revokes nothing. That leaves the legitimate session alive, which is
        // the same outcome the branch below reaches deliberately — and a leaked
        // code replayed later, which is the realistic case, does find the row.
        await store.revokeSession(record.redeemedSessionId, now().toISOString());
        return oauthError(
          reply,
          400,
          'invalid_grant',
          'This authorization code has already been used, and this request cannot prove it ' +
            'belongs to the flow that obtained it. The session the code created has been ' +
            'revoked; authorize again.',
        );
      }

      return oauthError(
        reply,
        400,
        'invalid_grant',
        'This authorization code has already been redeemed. It is single-use; the session it ' +
          'created is unaffected and still valid.',
      );
    }

    if (Date.parse(record.expiresAt) <= now().getTime()) {
      return oauthError(reply, 400, 'invalid_grant', 'Authorization code has expired.');
    }
    if (record.clientId !== client.clientId) {
      return oauthError(reply, 400, 'invalid_grant', 'This code was issued to another client.');
    }
    if (record.redirectUri !== (body.redirect_uri ?? record.redirectUri)) {
      return oauthError(
        reply,
        400,
        'invalid_grant',
        'redirect_uri does not match the one used to obtain this code.',
      );
    }
    if (!verifyPkce(verifier, record.codeChallenge)) {
      return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed.');
    }

    // The code carries the resource it was issued for, so the session lands on
    // the same tenant — and is stamped with the endpoint it may be used at.
    const codeTarget = await resolveTarget(record.resource);
    if (codeTarget === null) {
      return oauthError(reply, 400, 'invalid_target', 'That resource is no longer served here.');
    }

    const issued = mintTokens();
    const session: Session = {
      id: sessionId,
      clientId: client.clientId,
      accountId: record.accountId,
      tenantSiteId: codeTarget.store.tenant.tenantSiteId,
      scope: record.scope,
      accessTokenHash: hashToken(issued.accessToken),
      refreshTokenHash: hashToken(issued.refreshToken),
      accessTokenExpiresAt: issued.accessTokenExpiresAt,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      lastSeenAt: now().toISOString(),
      revokedAt: null,
    };

    await codeTarget.store.createSession(session);

    return noStore(reply).send({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlMinutes * 60,
      refresh_token: issued.refreshToken,
      scope: formatScope(record.scope),
    });
  }

  async function refresh(
    reply: FastifyReply,
    client: OAuthClient,
    body: Record<string, string>,
  ): Promise<FastifyReply> {
    const presented = body.refresh_token ?? '';
    if (presented === '') {
      return oauthError(reply, 400, 'invalid_request', 'refresh_token is required.');
    }

    const session = await store.findSessionByRefreshToken(hashToken(presented));

    if (!session || session.revokedAt !== null) {
      return oauthError(reply, 400, 'invalid_grant', 'Unknown or revoked refresh token.');
    }
    if (session.clientId !== client.clientId) {
      return oauthError(
        reply,
        400,
        'invalid_grant',
        'This refresh token was issued to another client.',
      );
    }
    if (Date.parse(session.refreshTokenExpiresAt) <= now().getTime()) {
      return oauthError(reply, 400, 'invalid_grant', 'Refresh token has expired.');
    }
    if (isIdle(session, config, now())) {
      await store.revokeSession(session.id, now().toISOString());
      return oauthError(
        reply,
        400,
        'invalid_grant',
        'Session timed out through inactivity. Authorize again.',
      );
    }

    // Rotation: the presented refresh token stops working the moment this
    // returns, so an intercepted copy has a single-use window rather than the
    // full remaining lifetime.
    const issued = mintTokens();

    await store.rotateSession(session.id, {
      accessTokenHash: hashToken(issued.accessToken),
      refreshTokenHash: hashToken(issued.refreshToken),
      accessTokenExpiresAt: issued.accessTokenExpiresAt,
      refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
      at: now().toISOString(),
    });

    return noStore(reply).send({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: config.accessTokenTtlMinutes * 60,
      refresh_token: issued.refreshToken,
      scope: formatScope(session.scope),
    });
  }

  function mintTokens() {
    const issuedAt = now().getTime();
    return {
      accessToken: generateSecret(ACCESS_TOKEN_PREFIX),
      refreshToken: generateSecret(REFRESH_TOKEN_PREFIX),
      accessTokenExpiresAt: new Date(
        issuedAt + config.accessTokenTtlMinutes * 60_000,
      ).toISOString(),
      refreshTokenExpiresAt: new Date(
        issuedAt + config.refreshTokenTtlDays * 86_400_000,
      ).toISOString(),
    };
  }

  // ---------------------------------------------------------------- revoke

  app.post('/oauth/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const token = body.token ?? '';

    // RFC 7009: the response is 200 whether or not anything was revoked, so a
    // caller cannot use this endpoint to probe which tokens exist.
    if (token !== '') {
      const hash = hashToken(token);
      const session =
        (await store.findSessionByAccessToken(hash)) ??
        (await store.findSessionByRefreshToken(hash));

      if (session) {
        await store.revokeSession(session.id, now().toISOString());
      }
    }

    return noStore(reply).code(200).send();
  });
}

/** Shared by the token endpoint and the bearer check on /mcp. */
export function isIdle(
  session: { lastSeenAt: string },
  config: Pick<Config, 'sessionInactivityTimeoutMinutes'>,
  at: Date,
): boolean {
  const idleMs = at.getTime() - Date.parse(session.lastSeenAt);
  return idleMs > config.sessionInactivityTimeoutMinutes * 60_000;
}
