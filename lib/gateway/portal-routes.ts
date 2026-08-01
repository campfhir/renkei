/**
 * `/me` — what a user can do for themselves.
 *
 * Get their connector URL, name the connection, see which AI clients hold a
 * session as them, revoke one, or disconnect the site entirely. None of it needs
 * an operator, which is the point: an operator who had to hand out connector
 * URLs would end up in the middle of every onboarding, and an operator who could
 * see a user's sessions well enough to manage them is halfway to acting as them.
 *
 * **How someone signs in here, and why there is no tenant in the URL.**
 *
 * A user's only identity is an Atlassian account, so sign-in is an Atlassian
 * round trip — and the site picker on Atlassian's own consent screen is the site
 * picker. What comes back is one cloud ID, which resolves to at most one
 * registered site claim, which names the tenant. So the flow needs no tenant
 * slug in the path, nothing for a stranger to enumerate, and nothing for an
 * operator to distribute beyond this deployment's base URL.
 *
 * Two consequences worth stating rather than discovering:
 *
 *   - **Sign-in stores the grant it obtains.** Discarding it would be tidier —
 *     a browser sign-in has no business minting a credential — but a second
 *     authorization for the same account, app, and site may invalidate the
 *     refresh chain the deployment already holds. Keeping the newer one means
 *     visiting this page cannot break a working connector. Signing in is
 *     therefore equivalent to connecting, minus the client.
 *   - **A tenant using its own Atlassian app cannot use this page yet.** Sign-in
 *     brokers through the deployment's shared app because there is no tenant to
 *     look one up for, so a site claimed by a tenant's own client ID does not
 *     resolve. Phase 6 owns bring-your-own-app configuration and owns closing
 *     this with a tenant-scoped entry point.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AtlassianAuthError,
  buildAuthorizeUrl,
  type AccessibleResource,
  type FetchLike,
} from '../auth/atlassian.js';
import { discoverAtlassianAuthorization } from '../auth/grant.js';
import type { Config } from '../config.js';
import { mcpResourceUrl } from './metadata.js';
import { portalPage, portalSignInPage } from '../ui/portal/pages.js';
import { errorPage, renderPage } from '../ui/render.js';
import { RateLimiter } from './rate-limit.js';
import type {
  GatewayStore,
  PendingPortalSignIn,
  PlatformAuditEvent,
  TenantContext,
} from './store.js';
import {
  constantTimeEquals,
  CSRF_TOKEN_PREFIX,
  generateSecret,
  hashToken,
  PORTAL_COOKIE_PREFIX,
} from './tokens.js';
import { bodyString, bodyText, queryString } from './request-input.js';

export interface PortalDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

const COOKIE_NAME = 'renkei_portal';

/** As long as an MCP client's own Atlassian round trip is given. */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;

/**
 * Two bounds, the same pair `sessions` carries: an idle timeout that activity
 * slides forward, and an outer limit that it does not. Not configurable, because
 * signing in again is one click that Atlassian will not re-prompt for, and the
 * page holds nothing worth keeping a cookie alive for overnight.
 */
const IDLE_MINUTES = 30;
const MAX_HOURS = 8;

/**
 * Only to stop a loop from filling `pending_authorizations`. Real rate limiting
 * belongs at the ingress, per Phase 8 — this is one unauthenticated endpoint
 * that writes a row, not a defence.
 */
const SIGN_IN_ATTEMPTS_PER_MINUTE = 10;

/** Fixed strings, keyed by a token in the URL. Never the query text itself. */
const NOTICES: Record<string, string> = {
  label: 'Name saved.',
  revoked: 'That session was revoked. The client will have to authorize again.',
  disconnected:
    'Disconnected. Every session for this site is revoked and the stored Atlassian credential is deleted.',
};

/** What a signed-in request has resolved to before any handler runs. */
interface PortalContext {
  /** Bound to the tenant and site the cookie's session belongs to. */
  store: GatewayStore;
  sessionId: string;
  accountId: string;
  csrfToken: string;
  tenant: TenantContext;
}

export function registerPortalRoutes(app: FastifyInstance, deps: PortalDeps): void {
  const { config, store, now } = deps;
  const signInLimiter = new RateLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE, () => now().getTime());

  function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
    // A page listing sessions must not sit in a shared cache, and `private`
    // alone still permits the browser's own back-button copy.
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(body);
  }

  // ------------------------------------------------------------- the page

  app.get('/me', async (request, reply) => {
    const context = await authenticate(deps, request);

    if (context === null) {
      // Clear whatever was presented on the way out: if a cookie arrived and did
      // not authenticate, it is expired, revoked, or for a site that no longer
      // answers, and none of those get better by keeping it.
      clearCookie(reply);
      return html(reply, renderPage(portalSignInPage(null)));
    }

    const link = await context.store.getLinkedSite(context.accountId);

    if (link === null) {
      // The link was removed under the session — an operator dropping the site,
      // or a disconnect racing another tab. Nothing to show, so the session is
      // over rather than half-rendered.
      await context.store.revokePortalSession(context.sessionId, now().toISOString());
      clearCookie(reply);
      return html(
        reply,
        renderPage(
          portalSignInPage('That connection is no longer registered here. Sign in again to check.'),
        ),
      );
    }

    const sessions = await context.store.listSessionsForSite(context.accountId);
    const notice = NOTICES[queryString(request, 'done') ?? ''] ?? null;

    return html(
      reply,
      renderPage(
        portalPage({
          displayName: await displayName(context),
          siteUrl: link.siteUrl,
          label: link.label,
          connectorUrl: mcpResourceUrl(config.publicBaseUrl, context.tenant.tenantSiteId),
          csrfToken: context.csrfToken,
          sessions,
          notice,
        }),
      ),
    );
  });

  // ----------------------------------------------------------------- sign-in

  app.get('/me/sign-in', async (request, reply) => {
    if (!signInLimiter.check(request.ip).allowed) {
      return html(
        reply,
        errorPage('Too many attempts', 'Wait a minute and try signing in again.'),
        429,
      );
    }

    const pending: PendingPortalSignIn = {
      kind: 'portal',
      brokerState: generateSecret(''),
      expiresAt: new Date(now().getTime() + SIGN_IN_TTL_MS).toISOString(),
    };

    await store.putPendingAuthorization(pending);

    // The shared deployment app: there is no tenant yet to look up an app for.
    // `forceLogin` so somebody already signed in to Atlassian as the wrong
    // account can choose — this page is where a person goes to see what is
    // connected as *them*, and the wrong account silently answering that
    // question is the confusing failure.
    return reply.redirect(
      buildAuthorizeUrl(config.atlassian, pending.brokerState, { forceLogin: true }),
      302,
    );
  });

  // ------------------------------------------------------------------ writes

  app.post('/me/label', async (request, reply) => {
    const context = await authorizeWrite(deps, request, reply, html);
    if (context === null) return reply;

    const raw = bodyText(request, 'label');
    // The column is capped at 60 characters; truncating beats a 500 from a
    // constraint violation for a field whose only job is to be recognizable.
    const label = raw === '' ? null : raw.slice(0, 60);

    await context.store.setLinkedSiteLabel(context.accountId, label);
    return reply.redirect('/me?done=label', 303);
  });

  app.post('/me/revoke', async (request, reply) => {
    const context = await authorizeWrite(deps, request, reply, html);
    if (context === null) return reply;

    const sessionId = bodyText(request, 'session');

    /**
     * Read the session through this store before revoking it, and check the
     * account. Row-level security already confines the lookup to the cookie's
     * tenant, but "this tenant" is not the check that matters here — a colleague
     * at the same site is in the same tenant, and their session is not this
     * user's to end.
     */
    const owned = (await context.store.listSessionsForSite(context.accountId)).some(
      (session) => session.id === sessionId,
    );

    if (owned) {
      await context.store.revokeSession(sessionId, now().toISOString());
    }

    // Same answer either way: whether some other session ID exists is not
    // something this form should be able to report.
    return reply.redirect('/me?done=revoked', 303);
  });

  app.post('/me/disconnect', async (request, reply) => {
    const context = await authorizeWrite(deps, request, reply, html);
    if (context === null) return reply;

    const at = now().toISOString();

    // Sessions first: while the grant is gone but a session lives, a call would
    // fail with a confusing "no credential" rather than a clean 401.
    await context.store.revokeSessionsForSite(context.accountId, at);
    await context.store.deleteGrant(context.accountId);

    /**
     * The link row stays. It is the record that this account chose this site,
     * several revoked sessions still reference it, and deleting it would cascade
     * them away — turning "I disconnected on Tuesday" into no evidence at all.
     * With no grant and no live session, the link grants nothing.
     */
    return reply.redirect('/me?done=disconnected', 303);
  });

  app.post('/me/sign-out', async (request, reply) => {
    const context = await authorizeWrite(deps, request, reply, html);
    if (context === null) return reply;

    await context.store.revokePortalSession(context.sessionId, now().toISOString());
    clearCookie(reply);
    return html(reply, renderPage(portalSignInPage('Signed out.')));
  });

  /** Set on the reply, so it has to be built where the reply is. */
  function clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', serializeCookie('', config, 0));
  }

  /**
   * The display name, read from the grant rather than kept on the session.
   *
   * One less copy of a person's name to hold, and the grant is the row that
   * Atlassian actually reported it on. Falls back rather than failing: a missing
   * grant after a disconnect is expected, and the page is still useful.
   */
  async function displayName(context: PortalContext): Promise<string> {
    const grant = await context.store.getGrant(context.accountId);
    return grant?.displayName ?? 'your Atlassian account';
  }
}

// ------------------------------------------------------------------- sign-in

/**
 * Completes a portal sign-in, called from `/oauth/callback`.
 *
 * The callback route lives with the OAuth surface because that is where the
 * `pending_authorizations` row is redeemed and where the Atlassian app has its
 * one registered redirect URI. What a portal sign-in *means* lives here.
 */
export async function completePortalSignIn(
  deps: PortalDeps,
  pending: PendingPortalSignIn,
  query: Record<string, string | undefined>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { config, store, now, fetchImpl } = deps;

  const fail = async (heading: string, detail: string, status = 400): Promise<FastifyReply> => {
    await recordSignIn(deps, request, 'failure', null, null);
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(errorPage(heading, detail));
  };

  if (Date.parse(pending.expiresAt) <= now().getTime()) {
    return fail(
      'That took too long',
      'The sign-in expired. Start again from this deployment’s page.',
    );
  }

  if (query.error !== undefined) {
    return fail(
      'Not authorized',
      'Atlassian did not complete the sign-in. If you declined the consent screen, sign in again ' +
        'and approve it.',
    );
  }

  const code = query.code ?? '';
  if (code === '') {
    return fail('Nothing to complete', 'Atlassian did not return an authorization code.');
  }

  /**
   * The site is discovered rather than pinned: which one this is *is* the
   * question, and the user answered it on Atlassian's consent screen.
   *
   * Exactly one of the returned sites has to be registered here. Zero is the
   * ordinary case of somebody whose site nobody has registered. More than one
   * cannot happen while consent is per site — verified against a live tenant —
   * and if Atlassian ever changes that, refusing is the only honest answer: this
   * flow would have no way to know which of two sites the person meant, and
   * guessing would bind their browser session to the wrong one.
   */
  // A holder rather than a bare `let`, because what the chooser assigns is read
  // after an await that the compiler cannot see through — narrowing a plain
  // local to `never` here and needing an assertion to get it back would hide
  // exactly the case the check below is for.
  const chosen: { tenant: TenantContext | null } = { tenant: null };

  const chooseSite = async (resources: readonly AccessibleResource[]) => {
    // Keyed by endpoint rather than collected into a list, so a duplicate entry
    // for one site is one candidate. Only genuinely different endpoints are
    // ambiguous.
    const claims = new Map<string, { resource: AccessibleResource; tenant: TenantContext }>();

    for (const resource of resources) {
      const tenant = await store.resolveSiteClaim(resource.id, config.atlassian.clientId);
      if (tenant !== null) claims.set(tenant.tenantSiteId, { resource, tenant });
    }

    const only = [...claims.values()][0];

    if (only === undefined) {
      throw new SignInRefused(
        'That site is not connected here',
        'You signed in to Atlassian successfully, but the site you picked is not registered with ' +
          'this deployment. Sign in again and choose a different site, or ask whoever administers ' +
          'this gateway to register it.',
      );
    }
    if (claims.size > 1) {
      throw new SignInRefused(
        'More than one site',
        'That Atlassian authorization covers several sites registered here, so Renkei cannot ' +
          'tell which one you meant. Authorize one site at a time.',
      );
    }

    chosen.tenant = only.tenant;
    return only.resource;
  };

  let grant;
  try {
    ({ grant } = await discoverAtlassianAuthorization(config.atlassian, code, {
      chooseSite,
      now,
      fetchImpl,
    }));
  } catch (error) {
    if (error instanceof SignInRefused) {
      return fail(error.heading, error.detail);
    }

    request.log.warn({ err: error }, 'portal sign-in failed');
    return fail(
      'Could not complete sign-in',
      error instanceof AtlassianAuthError
        ? 'Atlassian refused the sign-in. Try again; if it keeps failing, the deployment’s ' +
            'Atlassian app may need attention.'
        : 'Something went wrong completing the sign-in. Try again.',
      502,
    );
  }

  // `chooseSite` ran or the call above threw, so this is set. Checked anyway:
  // it is the one place a refactor could silently drop the tenant, and the
  // failure would be a session bound to nothing.
  const tenant = chosen.tenant;
  if (tenant === null) {
    return fail(
      'Could not complete sign-in',
      'The site this authorization covers did not resolve.',
    );
  }

  const scoped = store.forTenant(tenant);

  // The same three writes the MCP callback makes, in the same order: the user
  // row before the grant that references it, then the link that makes this
  // person a user of the tenant.
  await scoped.upsertUser(grant.accountId, grant.displayName);
  await scoped.putGrant(grant);
  await scoped.linkSite(grant.accountId);

  const secret = generateSecret(PORTAL_COOKIE_PREFIX);
  const issuedAt = now();

  await scoped.createPortalSession({
    id: randomUUID(),
    tenantSiteId: tenant.tenantSiteId,
    accountId: grant.accountId,
    tokenHash: hashToken(secret),
    csrfToken: generateSecret(CSRF_TOKEN_PREFIX),
    createdAt: issuedAt.toISOString(),
    lastSeenAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + MAX_HOURS * 3_600_000).toISOString(),
    revokedAt: null,
  });

  await recordSignIn(deps, request, 'success', tenant.tenantId, grant.accountId);

  reply.header(
    'set-cookie',
    serializeCookie(`${tenant.tenantSiteId}.${secret}`, config, MAX_HOURS * 3600),
  );

  return reply.redirect('/me', 302);
}

/** A sign-in Renkei declines for a reason the person can act on. */
class SignInRefused extends Error {
  readonly heading: string;
  readonly detail: string;

  constructor(heading: string, detail: string) {
    super(heading);
    this.name = 'SignInRefused';
    this.heading = heading;
    this.detail = detail;
  }
}

function recordSignIn(
  deps: PortalDeps,
  request: FastifyRequest,
  outcome: PlatformAuditEvent['outcome'],
  tenantId: string | null,
  accountId: string | null,
): Promise<void> {
  return deps.store
    .writePlatformAuditEvent({
      event: 'user_sign_in',
      outcome,
      sourceIp: request.ip === '' ? null : request.ip,
      userAgent: truncate(request.headers['user-agent']),
      // The path only. The callback's query string carries an Atlassian
      // authorization code, which must not reach any log.
      requestPath: request.url.split('?')[0] ?? null,
      targetTenantId: tenantId,
      accountId,
    })
    .catch((error: unknown) => {
      // A sign-in that worked should not fail because its audit row did not
      // insert; the platform log is for incident response, not authorization.
      request.log.warn({ err: error }, 'could not record portal sign-in');
    });
}

function truncate(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, 500);
}

// ---------------------------------------------------------------- the cookie

/**
 * `<tenantSiteId>.<secret>`.
 *
 * The site ID travels in the clear because the lookup needs it: reading
 * `portal_sessions` requires the transaction to already know its tenant, and the
 * only sanctioned way to get from a request to a tenant is
 * `renkei_resolve_endpoint`, which takes a site. Carrying it costs nothing —
 * the same UUID is the connector URL the page exists to hand out — and resolving
 * through that function re-checks on every request that the site is still
 * enabled and its tenant still active.
 *
 * A forged site ID gets a caller nowhere: the session is then looked up under
 * that site's tenant, and `token_hash` is not something they can produce.
 */
function serializeCookie(value: string, config: Config, maxAgeSeconds: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    // Scoped to the only routes that read it, so it is not attached to /mcp or
    // /oauth requests at all.
    'Path=/me',
    'HttpOnly',
    // Lax rather than Strict: sign-in returns here as a cross-site redirect from
    // Atlassian, and Strict would drop the cookie on exactly that navigation.
    // It still keeps the cookie off cross-site POSTs, which with the CSRF token
    // in every form is two independent reasons a forged submission fails.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];

  // Derived rather than configured: a Secure cookie is silently dropped over
  // plain HTTP, which would make local development mysteriously never sign in.
  if (config.publicBaseUrl.startsWith('https://')) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function readCookie(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return null;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === COOKIE_NAME) {
      return pair.slice(separator + 1).trim();
    }
  }

  return null;
}

// -------------------------------------------------------------- the session

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns the cookie into a tenant-scoped store and an account, or null.
 *
 * Null for every reason — no cookie, malformed, unknown site, suspended tenant,
 * expired, idle, revoked, or a session belonging to another site — because the
 * only useful thing to tell the person in the browser is "sign in again", and
 * distinguishing the cases would say more about this deployment than it needs to.
 */
async function authenticate(
  deps: PortalDeps,
  request: FastifyRequest,
): Promise<PortalContext | null> {
  const { store, now } = deps;

  const cookie = readCookie(request);
  if (cookie === null) return null;

  const separator = cookie.indexOf('.');
  if (separator <= 0) return null;

  const tenantSiteId = cookie.slice(0, separator);
  const secret = cookie.slice(separator + 1);

  // Shape-checked before it reaches the resolver, so a malformed value is a null
  // rather than a Postgres cast error surfacing as a 500.
  if (!UUID.test(tenantSiteId) || secret === '') return null;

  const tenant = await store.resolveEndpoint(tenantSiteId);
  if (tenant === null) return null;

  const scoped = store.forTenant(tenant);
  const session = await scoped.findPortalSession(hashToken(secret));

  if (session === null || session.revokedAt !== null) return null;

  // Audience binding, the same rule the MCP tokens follow: a session issued for
  // one site is not usable at another, even inside the same tenant, because the
  // Atlassian consent behind it covered one site.
  if (session.tenantSiteId !== tenantSiteId) return null;

  const at = now().getTime();
  if (Date.parse(session.expiresAt) <= at) return null;
  if (at - Date.parse(session.lastSeenAt) > IDLE_MINUTES * 60_000) return null;

  await scoped.touchPortalSession(session.id, new Date(at).toISOString());

  return {
    store: scoped,
    sessionId: session.id,
    accountId: session.accountId,
    csrfToken: session.csrfToken,
    tenant,
  };
}

/**
 * Authentication plus the CSRF check every POST here shares.
 *
 * Returns null having already answered the request, so a handler that forgets to
 * check the result sends nothing rather than acting unauthenticated.
 */
async function authorizeWrite(
  deps: PortalDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  html: (reply: FastifyReply, body: string, status?: number) => FastifyReply,
): Promise<PortalContext | null> {
  const context = await authenticate(deps, request);

  if (context === null) {
    html(
      reply,
      renderPage(portalSignInPage('Your session ended. Sign in again to make that change.')),
      401,
    );
    return null;
  }

  const presented = bodyString(request, 'csrf') ?? '';

  if (!constantTimeEquals(presented, context.csrfToken)) {
    // Reached by a cross-site submission or a stale open tab. Either way the
    // page has to be re-fetched to get a token that matches.
    html(
      reply,
      errorPage('That form was out of date', 'Reload the page and try again. Nothing was changed.'),
      403,
    );
    return null;
  }

  return context;
}
