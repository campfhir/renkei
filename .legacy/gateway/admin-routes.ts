/**
 * `/admin/<tenantSlug>` — the tenant operator console.
 *
 * **The slug in the path is what selects the identity provider**, and is still
 * how anyone who already knows their tenant signs in directly. Home-realm
 * discovery by email domain now also exists, at `/` (see wizard-routes.ts) —
 * the ambiguity that used to make domain-based routing unsafe is resolved by
 * `tenant_domains`' global uniqueness constraint: a domain names exactly one
 * tenant, so turning an email into a redirect here is unambiguous. This route
 * is unchanged for anyone who already has the direct link.
 *
 * **Nothing here can use a grant.** The routes hold an `AdminStore`, which has no
 * method that returns a decrypted Atlassian token, so "an operator may revoke a
 * grant but must never use one" is enforced by the type rather than by review.
 * That separation is what keeps the audit log meaning what it says: every row in
 * it is a user acting as themselves, and there is no impersonation path that
 * could put an operator's action under a user's name.
 *
 * Three things are deliberately separate from the delegation path, not shared
 * with it: this cookie, the `operator_sessions` table, and this route prefix. An
 * operator session must never be usable as a user session or as a bearer token,
 * and the cheapest way to guarantee that is for them to have nothing in common.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '../auth/atlassian.js';
import type { Config } from '../config.js';
import { renderPage, errorPage } from '../ui/render.js';
import {
  deviceApprovalPage,
  deviceCodePage,
  deviceOutcomePage,
  noConsolePage,
  operatorSignInPage,
  type ConsoleContext,
} from '../ui/admin/pages.js';
import type { AdminStore, TenantSummary } from './admin-store.js';
import { registerConsoleRoutes } from './console-routes.js';
import { DeviceAuthManager } from './device-auth.js';
import { OidcClient, OidcError, type OperatorIdentity } from './oidc.js';
import { RateLimiter } from './rate-limit.js';
import { bodyString, bodyText, queryString, queryStrings } from './request-input.js';
import type { GatewayStore, PlatformAuditEvent } from './store.js';
import { constantTimeEquals, CSRF_TOKEN_PREFIX, generateSecret, hashToken } from './tokens.js';

export interface AdminDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

const COOKIE_NAME = 'renkei_operator';

/** Long enough for an IdP that asks for a second factor. */
const SIGN_IN_TTL_MS = 15 * 60 * 1000;

/**
 * Shorter than the user-facing bounds, on purpose.
 *
 * This console can revoke every session a tenant has. An operator who walks away
 * from an unlocked laptop should not leave that reachable for the rest of the
 * afternoon, and signing in again costs one redirect that their IdP will usually
 * answer without a prompt.
 */
const IDLE_MINUTES = 15;
const MAX_HOURS = 4;

/** Only to stop a loop filling `operator_authorizations`; ingress is Phase 8's job. */
const SIGN_IN_ATTEMPTS_PER_MINUTE = 10;

/** Matches the `tenants_slug_shape` constraint, checked before the resolver sees it. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Fixed strings, keyed by a token in the URL. Never the query text itself. */
const NOTICES: Record<string, string> = {
  'signed-out': 'Signed out.',
  enabled: 'That site is answering again.',
  disabled: 'That site’s endpoint no longer resolves. Sessions are untouched.',
  'sessions-revoked': 'Sessions revoked. Those clients will have to authorize again.',
  'credential-deleted':
    'Sessions revoked and the stored Atlassian credential deleted. Their Jira account is untouched.',
  key: 'Key stored. It takes effect within a minute, and grants move to it as they refresh.',
  'key-cleared': 'Back to the deployment key.',
  claimed: 'Connected. Its endpoint is below.',
  'claim-conflict': 'Another tenant already has that cloud ID connected.',
  'claim-invalid': 'Could not resolve a cloud ID from that Jira URL.',
};

/** What an authenticated console request has resolved to. */
export interface OperatorContext {
  store: AdminStore;
  tenant: TenantSummary;
  sessionId: string;
  subject: string;
  operator: string;
  csrfToken: string;
}

/**
 * The machinery every console route shares.
 *
 * Built once and handed to each group of routes, so slug resolution, cookie
 * handling, and the CSRF check have one implementation rather than one per page —
 * and so a new page cannot accidentally be built on a store that is not
 * tenant-scoped, because the only way to get one is through `resolve`.
 */
export interface OperatorGate {
  resolve(slug: string): Promise<AdminStore | null>;
  authenticate(
    admin: AdminStore,
    slug: string,
    request: FastifyRequest,
  ): Promise<OperatorContext | null>;
  /**
   * Authentication plus the CSRF check every console POST shares. Returns null
   * having already answered the request, so a handler that ignores the result
   * sends nothing rather than acting unauthenticated.
   */
  authorizeWrite(
    admin: AdminStore,
    slug: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OperatorContext | null>;
  html(reply: FastifyReply, body: string, status?: number): FastifyReply;
  notFound(reply: FastifyReply): FastifyReply;
  consoleContext(
    context: OperatorContext,
    here: ConsoleContext['here'],
    request: FastifyRequest,
  ): ConsoleContext;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { config, store, now, fetchImpl } = deps;
  const oidc = new OidcClient({ fetchImpl, now });
  const signInLimiter = new RateLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE, () => now().getTime());

  function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
    // A console page lists sessions and audit rows. It must not sit in any cache,
    // shared or otherwise.
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(body);
  }

  function notFound(reply: FastifyReply): FastifyReply {
    return html(reply, renderPage(noConsolePage()), 404);
  }

  /**
   * Slug to `AdminStore`, or null.
   *
   * Null covers an unknown slug, a malformed one, and a suspended tenant. A
   * suspended tenant's console being unavailable is a decision rather than a side
   * effect: suspension is the platform operator cutting a tenant off, and an
   * operator who could still sign in and change site configuration would make it
   * a partial measure.
   */
  async function resolve(slug: string): Promise<AdminStore | null> {
    if (!SLUG.test(slug)) return null;

    const resolved = await store.resolveSlug(slug);
    if (resolved === null) return null;

    return store.admin(resolved.tenantId);
  }

  // ------------------------------------------------------------ the console

  app.get('/admin/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    const context = await authenticate(admin, slug, request);

    if (context === null) {
      clearCookie(reply, slug);
      const tenant = await admin.getTenant();
      const oidcConfig = await admin.getOidc();

      return html(
        reply,
        renderPage(
          operatorSignInPage({
            slug,
            tenantName: tenant?.name ?? slug,
            reason: NOTICES[queryString(request, 'done') ?? ''] ?? null,
            configured: oidcConfig !== null,
          }),
        ),
      );
    }

    // The door, not a page. Every console page is suffixed, which keeps this
    // route's only job — "sign in, or go where you were going" — from also being
    // the place one of them is rendered.
    return reply.redirect(`/admin/${slug}/sites`, 302);
  });

  // ----------------------------------------------------------------- sign-in

  app.get('/admin/:slug/sign-in', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    if (!signInLimiter.check(request.ip).allowed) {
      return html(
        reply,
        errorPage('Too many attempts', 'Wait a minute and try signing in again.'),
        429,
      );
    }

    const oidcConfig = await admin.getOidc();
    if (oidcConfig === null) {
      // Nothing to redirect to. The sign-in page says the same thing; this is the
      // path somebody reaches by following a bookmark straight here.
      return html(
        reply,
        errorPage(
          'No identity provider',
          'No identity provider is configured for this tenant, so there is nothing to sign in ' +
            'against. The platform operator who created the tenant configures one.',
        ),
        404,
      );
    }

    const verifier = generateSecret('');
    const pending = {
      state: generateSecret(''),
      nonce: generateSecret(''),
      codeVerifier: verifier,
      expiresAt: new Date(now().getTime() + SIGN_IN_TTL_MS).toISOString(),
    };

    let target: string;
    try {
      const provider = await oidc.discover(oidcConfig.issuer);
      target = oidc.buildAuthorizeUrl(provider, oidcConfig, {
        state: pending.state,
        nonce: pending.nonce,
        codeChallenge: challengeFor(verifier),
        redirectUri: redirectUri(config, slug),
      });
    } catch (error) {
      return failSignIn(request, reply, admin, error, 'failure');
    }

    // Stored only once the redirect is certain, so a broken IdP configuration
    // does not accumulate rows nobody will ever redeem.
    await admin.putOperatorAuthorization(pending);

    return reply.redirect(target, 302);
  });

  app.get('/admin/:slug/callback', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    const query = queryStrings(request);

    // Single use. An unrecognized state is an unsolicited callback, and there is
    // nowhere legitimate to send it.
    const state = query.state ?? '';
    const pending = state === '' ? null : await admin.takeOperatorAuthorization(state);

    if (pending === null) {
      return html(
        reply,
        errorPage(
          'Nothing to complete',
          'This sign-in link has already been used, has expired, or did not originate here. ' +
            'Start again from the console.',
        ),
        400,
      );
    }

    if (Date.parse(pending.expiresAt) <= now().getTime()) {
      return html(
        reply,
        errorPage('That took too long', 'The sign-in expired. Start again from the console.'),
        400,
      );
    }

    if (query.error !== undefined) {
      // The IdP declined, or the operator did. Pass the fact through without
      // inventing a reason; the IdP's own `error` value is not shown, because it
      // is attacker-influenceable text in a URL.
      return failSignIn(
        request,
        reply,
        admin,
        new OidcError(
          `idp returned ${query.error}`,
          'Your identity provider did not complete the sign-in. If you declined the prompt, start ' +
            'again and approve it.',
        ),
        'denied',
      );
    }

    const code = query.code ?? '';
    if (code === '') {
      return failSignIn(
        request,
        reply,
        admin,
        new OidcError('no code', 'Your identity provider returned no authorization code.'),
        'failure',
      );
    }

    const oidcConfig = await admin.getOidc();
    if (oidcConfig === null) {
      return failSignIn(
        request,
        reply,
        admin,
        new OidcError(
          'oidc configuration removed mid-flow',
          'This tenant’s identity provider configuration was removed while you were signing in.',
        ),
        'failure',
      );
    }

    let identity;
    try {
      const provider = await oidc.discover(oidcConfig.issuer);
      const idToken = await oidc.exchangeCode(provider, oidcConfig, {
        code,
        redirectUri: redirectUri(config, slug),
        codeVerifier: pending.codeVerifier,
      });
      identity = await oidc.verifyIdToken(provider, oidcConfig, idToken, pending.nonce);
    } catch (error) {
      // A role-claim refusal is `denied` rather than `failure`: the person
      // authenticated fine and is not authorized, which is a different thing to
      // read in the log a month later.
      const outcome =
        error instanceof OidcError && error.message.includes('required role')
          ? 'denied'
          : 'failure';
      return failSignIn(request, reply, admin, error, outcome);
    }

    const cookie = await mintOperatorSession(admin, identity, config, slug, now);
    await recordSignIn(request, admin, 'success', identity.subject);

    reply.header('set-cookie', cookie);
    return reply.redirect(`/admin/${slug}`, 302);
  });

  // ------------------------------------------------------------ device authorization (CLI)

  const deviceAuth = new DeviceAuthManager(store, now);

  app.post('/device/:slug/authorize', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return reply.code(404).send({ error: 'unknown_tenant' });

    const result = await deviceAuth.initiate(slug);
    return reply.send(result);
  });

  /** The code-entry page, with an optional complaint about the code just tried. */
  async function deviceCodePrompt(
    reply: FastifyReply,
    admin: AdminStore,
    slug: string,
    reason: string | null,
    status?: number,
  ): Promise<FastifyReply> {
    const tenant = await admin.getTenant();
    const oidcConfig = await admin.getOidc();

    return html(
      reply,
      renderPage(
        deviceCodePage({
          slug,
          tenantName: tenant?.name ?? 'Unknown tenant',
          reason,
          configured: oidcConfig !== null,
        }),
      ),
      status,
    );
  }

  app.get('/auth/device/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    if (!signInLimiter.check(request.ip).allowed) {
      return html(reply, errorPage('Too many attempts', 'Wait a minute and try again.'), 429);
    }

    const oidcConfig = await admin.getOidc();
    const userCode = (queryString(request, 'code') ?? '').toUpperCase();

    if (userCode === '') {
      return deviceCodePrompt(reply, admin, slug, null);
    }

    const record = await deviceAuth.getByUserCode(userCode, slug);

    // One answer for "no such code", "expired", and "already used". Which of the
    // three it is would let somebody with a stolen console URL probe for live
    // codes, and an operator who mistyped theirs is told to try again either way.
    if (record === null || record.approvedAt !== undefined || record.expiresAt <= now().getTime()) {
      return deviceCodePrompt(
        reply,
        admin,
        slug,
        'That code is not valid. Check your terminal.',
        400,
      );
    }

    if (oidcConfig === null) {
      return html(
        reply,
        errorPage(
          'IdP not configured',
          "This tenant's identity provider is not configured. Contact your administrator.",
        ),
      );
    }

    const state = generateSecret('');
    const nonce = generateSecret('');
    const codeVerifier = generateSecret('');

    // Through discovery and `buildAuthorizeUrl`, like the console's own sign-in.
    // This route used to assemble the URL by hand — issuer host, `/oauth/authorize`
    // hardcoded — which is not where most providers put their authorization
    // endpoint, and is not what the same tenant's console leg would have used.
    let target: string;
    try {
      const provider = await oidc.discover(oidcConfig.issuer);
      target = oidc.buildAuthorizeUrl(provider, oidcConfig, {
        state,
        nonce,
        codeChallenge: challengeFor(codeVerifier),
        redirectUri: deviceRedirectUri(config, slug),
      });
    } catch (error) {
      return failSignIn(request, reply, admin, error, 'failure');
    }

    await admin.putOperatorAuthorization({
      state,
      nonce,
      codeVerifier,
      expiresAt: new Date(now().getTime() + SIGN_IN_TTL_MS).toISOString(),
      deviceCode: record.deviceCode,
    });

    return reply.redirect(target, 302);
  });

  app.get('/auth/device/:slug/callback', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    const state = queryString(request, 'state') ?? '';
    const pending = state === '' ? null : await admin.takeOperatorAuthorization(state);

    if (pending === null) {
      return html(
        reply,
        errorPage(
          'Nothing to complete',
          'This sign-in link has already been used, has expired, or did not originate here.',
        ),
        400,
      );
    }

    if (Date.parse(pending.expiresAt) <= now().getTime()) {
      return html(
        reply,
        errorPage('That took too long', 'The sign-in expired. Start again from the CLI.'),
        400,
      );
    }

    // A console sign-in's `state` must not be redeemable here: it was minted
    // without a device code, and completing it on this leg would produce a
    // confirmation page for nothing.
    if (pending.deviceCode === undefined || pending.deviceCode === '') {
      return html(
        reply,
        errorPage(
          'Nothing to complete',
          'This sign-in did not start from a command line. Start again from the CLI.',
        ),
        400,
      );
    }

    if (queryString(request, 'error') !== null) {
      return html(
        reply,
        errorPage(
          'Sign-in declined',
          'Your identity provider did not complete the sign-in. If you declined the prompt, ' +
            'start again and approve it.',
        ),
        400,
      );
    }

    const code = queryString(request, 'code');
    if (code === null) {
      return html(
        reply,
        errorPage(
          'No authorization code',
          'Your identity provider returned no authorization code.',
        ),
        400,
      );
    }

    const oidcConfig = await admin.getOidc();
    if (oidcConfig === null) {
      return html(
        reply,
        errorPage(
          'IdP configuration removed',
          "This tenant's identity provider configuration was removed while you were signing in.",
        ),
        400,
      );
    }

    let identity;
    let idToken: string;
    try {
      const provider = await oidc.discover(oidcConfig.issuer);
      idToken = await oidc.exchangeCode(provider, oidcConfig, {
        code,
        redirectUri: deviceRedirectUri(config, slug),
        codeVerifier: pending.codeVerifier,
      });
      identity = await oidc.verifyIdToken(provider, oidcConfig, idToken, pending.nonce);
    } catch (error) {
      // Through `failSignIn` like the console leg, which records the attempt and
      // shows `OidcError.detail` rather than a raw `error.message` — a group-claim
      // refusal should not describe the tenant's IdP configuration to whoever
      // triggered it.
      const outcome =
        error instanceof OidcError && error.message.includes('required group')
          ? 'denied'
          : 'failure';
      return failSignIn(request, reply, admin, error, outcome);
    }

    /**
     * Authenticated, and deliberately not yet approved.
     *
     * Everything up to here can be driven by somebody who is not the operator:
     * they mint a device code, send the pre-filled link, and an active SSO session
     * carries the operator through without a prompt. So the token goes into the
     * row and stays there, and the page below asks the one question that only the
     * real operator can answer — is this your terminal's code?
     */
    let staged;
    try {
      staged = await deviceAuth.stage(
        pending.deviceCode,
        slug,
        identity.subject,
        idToken,
        identity.displayName ?? identity.subject,
      );
    } catch (error) {
      request.log.warn({ err: error }, 'device authorization could not be staged');
      return html(
        reply,
        errorPage(
          'That code is no longer waiting',
          'The command line that started this sign-in has given up, or the code was already used. ' +
            'Start again from the CLI.',
        ),
        400,
      );
    }

    const tenant = await admin.getTenant();
    return html(
      reply,
      renderPage(
        deviceApprovalPage({
          slug,
          tenantName: tenant?.name ?? 'Unknown tenant',
          userCode: staged.userCode,
          operator: staged.operator,
          approvalToken: staged.approvalToken,
        }),
      ),
    );
  });

  /**
   * The confirmation. Not reachable without having just authenticated.
   *
   * The `approval` field is the whole authorization check: it was minted during
   * the IdP round trip and rendered into exactly one page, so a request carrying a
   * valid one came from the browser that authenticated. That makes a separate CSRF
   * token redundant here — there is no ambient credential for a cross-site form to
   * ride on, and a form that already has the secret is not a forgery.
   */
  app.post('/auth/device/:slug/approve', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    const approvalToken = bodyString(request, 'approval');
    const denied = bodyText(request, 'decision') === 'deny';
    const tenant = await admin.getTenant();

    if (approvalToken === null) {
      return html(reply, errorPage('That form was incomplete', 'Start again from the CLI.'), 400);
    }

    const record = denied
      ? await deviceAuth.deny(approvalToken, slug)
      : await deviceAuth.approve(approvalToken, slug);

    if (record === null) {
      // Expired, already answered, or a token that never existed. One answer for
      // all three: none of them leaves anything for this page to do.
      return html(
        reply,
        errorPage(
          'Nothing left to approve',
          'That confirmation has already been used or has expired. Start again from the CLI.',
        ),
        400,
      );
    }

    await recordEvent(
      request,
      admin,
      'device_authorization',
      denied ? 'denied' : 'success',
      record.operatorSubject ?? null,
    );

    return html(
      reply,
      renderPage(
        deviceOutcomePage({ tenantName: tenant?.name ?? 'Unknown tenant', approved: !denied }),
      ),
      denied ? 403 : 200,
    );
  });

  app.post('/device/:slug/token', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return reply.code(404).send({ error: 'unknown_tenant' });

    const deviceCode = bodyString(request, 'device_code');
    if (deviceCode === null) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const result = await deviceAuth.token(deviceCode, slug);

    if ('error' in result) {
      return reply.code(400).send({
        error: result.error,
        error_description:
          result.error === 'authorization_pending'
            ? 'Waiting for the operator to approve this device in a browser'
            : 'Device code expired',
      });
    }

    return reply.send({
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
    });
  });

  app.post('/admin/:slug/sign-out', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (admin === null) return notFound(reply);

    const context = await authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 303);

    if (!constantTimeEquals(csrfFrom(request), context.csrfToken)) {
      return html(
        reply,
        errorPage('That form was out of date', 'Reload the page and try again.'),
        403,
      );
    }

    await admin.revokeOperatorSession(context.sessionId, now().toISOString());
    clearCookie(reply, slug);
    return reply.redirect(`/admin/${slug}?done=signed-out`, 303);
  });

  // ------------------------------------------------------------------ shared

  /**
   * Renders an error page and records the refusal.
   *
   * Every sign-in failure produces one row in the platform log — the write-only
   * one, so a request-handling path can record a refusal and cannot read back
   * what was noticed — and one page whose detail is the `OidcError`'s, which is
   * specific about configuration and silent about verification internals.
   */
  async function failSignIn(
    request: FastifyRequest,
    reply: FastifyReply,
    admin: AdminStore,
    error: unknown,
    outcome: PlatformAuditEvent['outcome'],
  ): Promise<FastifyReply> {
    request.log.warn({ err: error }, 'operator sign-in failed');
    await recordSignIn(request, admin, outcome, null);

    const detail =
      error instanceof OidcError
        ? error.detail
        : 'Something went wrong completing the sign-in. Try again.';

    return html(reply, errorPage('Could not sign you in', detail), 403);
  }

  function recordSignIn(
    request: FastifyRequest,
    admin: AdminStore,
    outcome: PlatformAuditEvent['outcome'],
    subject: string | null,
  ): Promise<void> {
    return recordEvent(request, admin, 'operator_sign_in', outcome, subject);
  }

  function recordEvent(
    request: FastifyRequest,
    admin: AdminStore,
    event: PlatformAuditEvent['event'],
    outcome: PlatformAuditEvent['outcome'],
    subject: string | null,
  ): Promise<void> {
    return store
      .writePlatformAuditEvent({
        event,
        outcome,
        sourceIp: request.ip === '' ? null : request.ip,
        userAgent: userAgent(request),
        // The path only. A callback's query string carries an authorization code.
        requestPath: request.url.split('?')[0] ?? null,
        targetTenantId: admin.tenantId,
        // Deliberately not recorded: `atlassian_account_id` is for Atlassian
        // identities, and an IdP subject is not one. Conflating them would make
        // the column mean two things.
        accountId: null,
      })
      .catch((cause: unknown) => {
        request.log.warn({ err: cause, subject }, 'could not record operator sign-in');
      });
  }

  function clearCookie(reply: FastifyReply, slug: string): void {
    reply.header('set-cookie', serializeCookie('', config, slug, 0));
  }

  function consoleContext(
    context: OperatorContext,
    here: ConsoleContext['here'],
    request: FastifyRequest,
  ): ConsoleContext {
    const done = queryString(request, 'done') ?? '';
    return {
      tenant: context.tenant,
      operator: context.operator,
      csrfToken: context.csrfToken,
      here,
      notice: NOTICES[done] ?? null,
    };
  }

  /**
   * Turns the cookie into an operator, or null.
   *
   * Null for every reason — no cookie, expired, idle, revoked — because the only
   * useful thing to tell the browser is "sign in again". The session is read
   * through the tenant-scoped store the slug resolved to, so a cookie minted for
   * one tenant finds no row at another even before the path check below.
   */
  async function authenticate(
    admin: AdminStore,
    slug: string,
    request: FastifyRequest,
  ): Promise<OperatorContext | null> {
    const secret = readCookie(request);
    if (secret === null) return null;

    const session = await admin.findOperatorSession(hashToken(secret));
    if (session === null || session.revokedAt !== null) return null;

    const at = now().getTime();
    if (Date.parse(session.expiresAt) <= at) return null;
    if (at - Date.parse(session.lastSeenAt) > IDLE_MINUTES * 60_000) return null;

    const tenant = await admin.getTenant();
    if (tenant === null || tenant.slug !== slug) return null;

    await admin.touchOperatorSession(session.id, new Date(at).toISOString());

    return {
      store: admin,
      tenant,
      sessionId: session.id,
      subject: session.subject,
      operator: session.displayName ?? session.subject,
      csrfToken: session.csrfToken,
    };
  }

  async function authorizeWrite(
    admin: AdminStore,
    slug: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OperatorContext | null> {
    const context = await authenticate(admin, slug, request);

    if (context === null) {
      clearCookie(reply, slug);
      html(
        reply,
        errorPage('Your session ended', 'Sign in again to make that change. Nothing was changed.'),
        401,
      );
      return null;
    }

    if (!constantTimeEquals(csrfFrom(request), context.csrfToken)) {
      // Reached by a cross-site submission or a stale open tab. Either way the
      // page has to be re-fetched to get a token that matches.
      html(
        reply,
        errorPage(
          'That form was out of date',
          'Reload the page and try again. Nothing was changed.',
        ),
        403,
      );
      return null;
    }

    return context;
  }

  // The console's own pages live in their own modules and are registered with the
  // machinery above, so none of them can reach a store that is not tenant-scoped.
  const gate: OperatorGate = {
    resolve,
    authenticate,
    authorizeWrite,
    html,
    notFound,
    consoleContext,
  };

  registerConsoleRoutes(app, deps, gate);
}

/** The `/admin` cookie. A distinct prefix so it cannot be mistaken for a bearer token. */
export const OPERATOR_COOKIE_PREFIX = 'renkei_op_';

/**
 * The submitted CSRF token, or `''`.
 *
 * `''` for a body that is missing, malformed, or carries a `csrf` that is not a
 * string — all of which then fail `constantTimeEquals` and get a 403. The cast
 * this replaces let `{"csrf": 123}` reach `Buffer.from(123, 'utf8')`, which
 * throws, so a malformed body was answered with a 500 instead of the refusal it
 * had earned.
 */
export function csrfFrom(request: FastifyRequest): string {
  return bodyString(request, 'csrf') ?? '';
}

export function userAgent(request: FastifyRequest): string | null {
  const value = request.headers['user-agent'];
  return typeof value === 'string' && value !== '' ? value.slice(0, 500) : null;
}

function redirectUri(config: Config, slug: string): string {
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/admin/${slug}/callback`;
}

/**
 * Turns a verified identity into a live operator session and the `Set-Cookie`
 * header value for it — the same steps `/admin/:slug/callback` takes after
 * its own OIDC round trip, extracted so the self-service wizard's own round
 * trip (verifying a brand-new tenant's very first operator, in
 * wizard-routes.ts) can land the operator in the console already signed in
 * without a second login. "How a session becomes a cookie" stays in one
 * place either way.
 */
export async function mintOperatorSession(
  admin: AdminStore,
  identity: OperatorIdentity,
  config: Config,
  slug: string,
  now: () => Date,
): Promise<string> {
  const secret = generateSecret(OPERATOR_COOKIE_PREFIX);
  const issuedAt = now();

  await admin.createOperatorSession({
    id: randomUUID(),
    subject: identity.subject,
    displayName: identity.displayName,
    tokenHash: hashToken(secret),
    csrfToken: generateSecret(CSRF_TOKEN_PREFIX),
    createdAt: issuedAt.toISOString(),
    lastSeenAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + MAX_HOURS * 3_600_000).toISOString(),
    revokedAt: null,
  });

  return serializeCookie(secret, config, slug, MAX_HOURS * 3600);
}

/**
 * Separate from the console's, so the two legs cannot be crossed.
 *
 * A device sign-in that came back to `/admin/:slug/callback` would be handed an
 * operator cookie and no confirmation step; a console sign-in that came back here
 * would be asked to approve a device that does not exist. Distinct URIs mean the
 * IdP's own `redirect_uri` check keeps each `state` on the leg that minted it.
 */
function deviceRedirectUri(config: Config, slug: string): string {
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/auth/device/${slug}/callback`;
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Scoped to this tenant's own prefix, so an operator of two tenants holds two
 * cookies and neither is ever sent to the other's pages. Path matching is
 * prefix-plus-boundary, so `/admin/acme` is not sent to `/admin/acmex`.
 */
function serializeCookie(
  value: string,
  config: Config,
  slug: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    `Path=/admin/${slug}`,
    'HttpOnly',
    // Lax rather than Strict: the IdP returns here as a cross-site redirect, and
    // Strict would drop the cookie on exactly that navigation. Cross-site POSTs
    // still do not carry it, and every form carries a CSRF token besides.
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
      const value = pair.slice(separator + 1).trim();
      return value === '' ? null : value;
    }
  }

  return null;
}
