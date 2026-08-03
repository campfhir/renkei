/**
 * The MCP endpoint, and the per-user delegation that makes Renkei a gateway
 * rather than a shared proxy.
 *
 * Every request is authenticated to a session, the session resolves to an
 * Atlassian account, and the Jira client built for that request carries *that
 * person's* token. Nothing here holds a service account, and there is no code
 * path that can construct a client for a user other than the authenticated
 * one — the account ID comes from the session row, never from the request.
 *
 * The transport runs stateless: one `McpServer` and one transport per POST,
 * discarded when it completes. That costs a little setup per call and buys
 * three things worth more — a request can be served by any replica, a session
 * whose scope changed takes effect on the next call rather than the next
 * reconnect, and nothing user-specific outlives the request that created it.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '../auth/atlassian.js';
import { TokenProvider } from '../auth/token-provider.js';
import type { Config } from '../config.js';
import { JiraClient } from '../jira/client.js';
import { UserResolver } from '../jira/user-resolver.js';
import { createMcpServer } from '../mcp/server.js';
import { SCOPE_WRITE } from './scopes.js';
import { bearerChallenge } from './metadata.js';
import { isIdle } from './oauth-routes.js';
import { RateLimiter } from './rate-limit.js';
import { logAuthError, logRateLimit } from '../logging/bored-logger.js';
import { ScopedGrantStore, type GatewayStore, type Session } from './store.js';
import { hashToken } from './tokens.js';

export interface McpRouteDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

/**
 * Cached per (endpoint, account), not per request — see `providerKey`.
 *
 * `TokenProvider` is what serializes Atlassian refreshes, and Atlassian rotates
 * the refresh token on every use — two concurrent refreshes for one user means
 * one of them persists a token the other has already spent. A fresh provider
 * per request would lose that protection entirely, so the provider outlives
 * the request.
 *
 * This is per process. Across replicas, two nodes can still refresh the same
 * grant concurrently; Atlassian's 10-minute reuse window is what covers that,
 * and it is the reason the window exists.
 */
class ProviderCache {
  readonly #providers = new Map<string, { provider: TokenProvider; touchedAt: number }>();
  readonly #idleMs: number;

  constructor(idleMinutes: number) {
    this.#idleMs = idleMinutes * 60_000;
  }

  get(key: string, build: () => TokenProvider, at: number): TokenProvider {
    this.#evict(at);

    const existing = this.#providers.get(key);
    if (existing) {
      existing.touchedAt = at;
      return existing.provider;
    }

    const provider = build();
    this.#providers.set(key, { provider, touchedAt: at });
    return provider;
  }

  drop(key: string): void {
    this.#providers.delete(key);
  }

  /** A decrypted grant should not sit in memory longer than the session can live. */
  #evict(at: number): void {
    for (const [key, entry] of this.#providers) {
      if (at - entry.touchedAt > this.#idleMs) {
        this.#providers.delete(key);
      }
    }
  }
}

interface Authenticated {
  session: Session;
}

/**
 * Checked before the resolver so a malformed path is refused identically to an
 * unknown one, rather than surfacing a Postgres cast error that would confirm
 * the shape of the identifier.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A provider is scoped to (endpoint, account), not to the account alone.
 *
 * The grant behind it belongs to one site, and with a tenant's own Atlassian app
 * it is refreshed with that tenant's client credentials — so one contractor
 * using two of this deployment's endpoints must not be served the provider built
 * for the other one.
 */
function providerKey(tenantSiteId: string, accountId: string): string {
  return `${tenantSiteId}:${accountId}`;
}

export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): void {
  const { config, store, now, fetchImpl } = deps;
  const limiter = new RateLimiter(config.rateLimitPerUserPerMinute, () => now().getTime());
  const providers = new ProviderCache(config.sessionInactivityTimeoutMinutes);

  /**
   * The challenge names the endpoint that was asked for, not the deployment's
   * default one.
   *
   * `resource_metadata` is where the client goes to learn which resource to
   * request a token for. Pointing every 401 at the bare `/mcp` document sent a
   * client that had asked for `/mcp/<tenantSiteId>` off to authorize for a
   * different site, and the token it came back with was then refused here —
   * a connector that loops through sign-in and never connects. Echoing the
   * requested ID discloses nothing: it is the client's own path, and the
   * metadata route answers for any well-formed ID whether or not it exists.
   */
  function unauthorized(
    request: FastifyRequest,
    reply: FastifyReply,
    error: string,
    description: string,
  ): FastifyReply {
    const { tenantSiteId } = request.params as { tenantSiteId?: string };

    return reply
      .code(401)
      .header(
        'www-authenticate',
        bearerChallenge(config.publicBaseUrl, error, description, tenantSiteId),
      )
      .send({ error, error_description: description });
  }

  /**
   * Resolves `/mcp/<tenantSiteId>` to the store bound to that tenant.
   *
   * Every failure returns the same 401 the missing-token case returns, so an
   * unknown endpoint, a suspended tenant, and a real endpoint presented without
   * a token are indistinguishable from outside. That is what keeps the endpoint
   * namespace from being enumerable.
   *
   * There is no bare `/mcp` anymore — every tenant, including a deployment
   * that only ever creates one, mints its endpoint through the same
   * self-service wizard or `pnpm tenant claim-site`, so there is no more
   * "the deployment's configured tenant" to fall back to. A caller with no
   * `tenantSiteId` gets the same answer as an unknown one.
   */
  async function resolveStore(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<GatewayStore | null> {
    const { tenantSiteId } = request.params as { tenantSiteId?: string };

    // Ordering matters more than it looks. "No bearer token" is answered before
    // the endpoint is resolved, because that answer is identical on every path
    // and so discloses nothing. Resolving first let an unauthenticated caller
    // tell a real endpoint from a fake one by which error came back, which is
    // exactly the enumeration this design exists to prevent. Found by probing a
    // running server; the with-token case had looked correct.
    if (!hasBearer(request)) {
      unauthorized(request, reply, 'invalid_request', 'A bearer token is required.');
      return null;
    }

    const endpoint = tenantSiteId;

    if (endpoint === undefined || !UUID.test(endpoint)) {
      unauthorized(
        request,
        reply,
        'invalid_token',
        'The access token is unknown or has been revoked.',
      );
      return null;
    }

    const tenant = await store.resolveEndpoint(endpoint);
    if (tenant === null) {
      unauthorized(
        request,
        reply,
        'invalid_token',
        'The access token is unknown or has been revoked.',
      );
      return null;
    }

    return store.forTenant(tenant);
  }

  function hasBearer(request: FastifyRequest): boolean {
    const header = request.headers.authorization;
    return typeof header === 'string' && header.toLowerCase().startsWith('bearer ');
  }

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    store: GatewayStore,
  ): Promise<Authenticated | null> {
    const header = request.headers.authorization;

    if (typeof header !== 'string' || !hasBearer(request)) {
      unauthorized(request, reply, 'invalid_request', 'A bearer token is required.');
      return null;
    }

    // Scoped to the endpoint's tenant, so a token belonging to another tenant
    // is simply not visible here — the refusal is the database's, not an `if`
    // that a later change could forget.
    const session = await store.findSessionByAccessToken(hashToken(header.slice(7).trim()));
    const at = now();

    if (!session || session.revokedAt !== null) {
      unauthorized(
        request,
        reply,
        'invalid_token',
        'The access token is unknown or has been revoked.',
      );
      return null;
    }
    if (Date.parse(session.accessTokenExpiresAt) <= at.getTime()) {
      unauthorized(request, reply, 'invalid_token', 'The access token has expired; refresh it.');
      return null;
    }
    if (isIdle(session, config, at)) {
      // Idle expiry is a revocation, not a refresh opportunity — otherwise the
      // timeout means nothing to a client that keeps refreshing.
      await store.revokeSession(session.id, at.toISOString());
      providers.drop(providerKey(store.tenant.tenantSiteId, session.accountId));
      unauthorized(request, reply, 'invalid_token', 'The session timed out through inactivity.');
      return null;
    }

    if (session.tenantSiteId !== store.tenant.tenantSiteId) {
      // Same tenant, different registered site. Row-level security cannot catch
      // this one, and the per-site consent the user gave would mean nothing if
      // a token minted for one site worked at the other.
      unauthorized(
        request,
        reply,
        'invalid_token',
        'The access token is unknown or has been revoked.',
      );
      return null;
    }

    return { session };
  }

  const handleMcp = async (request: FastifyRequest, reply: FastifyReply) => {
    const scoped = await resolveStore(request, reply);
    if (!scoped) {
      return reply;
    }

    const authenticated = await authenticate(request, reply, scoped);
    if (!authenticated) {
      return reply;
    }

    const store = scoped;
    const { session } = authenticated;
    const at = now();

    const decision = limiter.check(session.accountId);
    if (!decision.allowed) {
      logRateLimit({
        tenantId: scoped.tenant.tenantId,
        accountId: session.accountId,
        limit: config.rateLimitPerUserPerMinute,
        windowMinutes: 1,
      });
      return reply
        .code(429)
        .header('retry-after', String(decision.retryAfterSeconds))
        .send({
          error: 'rate_limited',
          error_description:
            `More than ${config.rateLimitPerUserPerMinute} calls in a minute. ` +
            `Retry in ${decision.retryAfterSeconds}s.`,
        });
    }

    const grantStore = new ScopedGrantStore(store, session.accountId);
    const grant = await grantStore.read();

    if (!grant) {
      // The session outlived its grant — an operator revoked it, or the user
      // withdrew consent at Atlassian. Reporting it as an invalid token is
      // what makes the client start a fresh authorization instead of retrying.
      logAuthError({
        tenantId: scoped.tenant.tenantId,
        accountId: session.accountId,
        reason: 'grant_missing',
      });
      await store.revokeSession(session.id, at.toISOString());
      return unauthorized(
        request,
        reply,
        'invalid_token',
        'The Atlassian authorization behind this session is gone. Reconnect to re-authorize.',
      );
    }

    /**
     * The site comes from the resolved endpoint, not from config.
     *
     * Invisible on a single-tenant deployment, where the configured cloud ID *is*
     * the only registered site, and load-bearing the moment a second one exists:
     * the grant behind this session belongs to the endpoint's site, so calling
     * Jira at `ATLASSIAN_CLOUD_ID` would aim one tenant's token at another
     * tenant's site, and `TokenProvider`'s site-pinning check would refuse the
     * grant outright rather than refresh it.
     */
    const atlassian = {
      ...config.atlassian,
      cloudId: store.tenant.cloudId,
    };

    const provider = providers.get(
      providerKey(store.tenant.tenantSiteId, session.accountId),
      () => new TokenProvider({ store: grantStore, atlassian, fetchImpl }),
      at.getTime(),
    );

    // Generate a temporary reauth state for error links (single-use, expires in 10 min)
    const reauthState = await store.createReauthState(
      session.id,
      new Date(now().getTime() + 10 * 60 * 1000).toISOString(),
    );

    const baseUrl = config.publicBaseUrl.replace(/\/+$/, '');
    const reauthLink = `${baseUrl}/mcp/reauth?state=${encodeURIComponent(reauthState)}`;

    const client = new JiraClient({
      cloudId: atlassian.cloudId,
      getAccessToken: () => provider.getAccessToken(),
      fetchImpl,
    });

    const server = createMcpServer({
      context: {
        client,
        audit: { write: (event) => store.writeAuditEvent(event) },
        accountId: session.accountId,
        siteUrl: grant.siteUrl,
        maxJqlResults: config.maxJqlResults,
        maxAttachmentBytes: config.maxAttachmentBytes,
        getAuthRefreshLink: () => reauthLink,
        resolver: new UserResolver(client),
        playbooks: {
          list: () =>
            store
              .listPlaybooks()
              .then((rows) =>
                rows.filter((r) => r.enabled).map(({ slug, title }) => ({ slug, title })),
              ),
          get: (slug) => store.getPlaybook(slug).then((p) => (p && p.enabled ? p : null)),
        },
      },
      // Both gates apply: the deployment's, and this session's own scope.
      allowWrites: !config.readOnly && session.scope.includes(SCOPE_WRITE),
    });

    const transport = new StreamableHTTPServerTransport({
      // No sessionIdGenerator: absent means stateless, which is what this
      // wants — no server-held stream state, so any replica can serve any
      // call. MCP session continuity comes from the OAuth session instead.
      // (Passing `undefined` explicitly is the documented spelling but does
      // not typecheck under exactOptionalPropertyTypes; omission is identical
      // at runtime.)
      enableJsonResponse: true,
    });

    // Fastify has already parsed the JSON body; handing it over avoids the
    // transport trying to read a consumed stream.
    reply.hijack();

    try {
      // The transport exposes onclose/onerror/onmessage as accessors typed
      // `T | undefined`, while the Transport interface declares them optional.
      // Identical at runtime, different types under exactOptionalPropertyTypes.
      // Narrowed here rather than loosening the compiler for the whole project.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }

    // Best-effort: a failed touch must not fail the call the user just made.
    await store.touchSession(session.id, at.toISOString()).catch(() => undefined);

    return reply;
  };

  // Bare `/mcp` is kept registered rather than left to 404: it must answer the
  // same 401 an unknown or a real-but-unauthenticated endpoint does, or its
  // distinct status becomes an enumeration oracle in its own right. It never
  // resolves to a tenant — see resolveStore.
  app.post('/mcp', handleMcp);
  app.post('/mcp/:tenantSiteId', handleMcp);

  // Stateless mode has no server-initiated stream and no session to delete.
  // Answering explicitly is friendlier than Fastify's 404, which a client
  // reads as "wrong URL" rather than "not offered".
  for (const method of ['get', 'delete'] as const) {
    for (const path of ['/mcp', '/mcp/:tenantSiteId'] as const)
      app[method](path, (_request, reply) =>
        reply
          .code(405)
          .header('allow', 'POST')
          .send({
            error: 'method_not_allowed',
            error_description:
              'This endpoint runs stateless: POST a JSON-RPC message. There is no SSE stream to ' +
              'open and no session to delete.',
          }),
      );
  }
}
