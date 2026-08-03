/**
 * `/platform` — the deployment operator's console.
 *
 * **What this exists to break.** Registering a Jira site needs a tenant operator
 * signed in at `/admin/<slug>`; signing in there needs a row in `tenant_oidc`; and
 * until this existed, that row had one writer — a CLI on a privileged database
 * connection. So onboarding a tenant required somebody with database access. This
 * console creates the tenant and hands out a one-time link that lets the tenant's
 * own operator configure their own provider.
 *
 * **The fourth kind of session, sharing nothing with the other three.** A separate
 * cookie, a separate table, a separate route prefix. A platform session must never
 * be usable as an operator session, a portal session, or a bearer token, and the
 * cheapest way to guarantee that is for them to have nothing in common.
 *
 * **What it cannot do is a property of the database, not of this file.** The routes
 * hold a `PlatformStore` on a connection whose role is granted `tenants`,
 * `tenant_onboarding_tokens`, its own three tables, and a column-level slice of
 * `tenant_oidc` that excludes the client secret. A site list, a user list, an audit
 * row, a grant, or a tenant's IdP credential is a permission error here rather than
 * a method nobody wrote. Migration 019 has the matrix.
 *
 * Audit rows go through the *application* store, because `platform_audit_log` is
 * write-only to `renkei_app` and unreachable by the platform role — deliberately,
 * since a console that could read the rows describing attacks is a console an
 * attacker can use to learn what was noticed.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '../auth/atlassian.js';
import type { Config, PlatformOidcConfig } from '../config.js';
import type { Notifier } from '../notify/notifier.js';
import { errorPage, renderPage } from '../ui/render.js';
import {
  noPlatformConsolePage,
  platformSignInPage,
  type PlatformConsoleContext,
} from '../ui/platform/pages.js';
import { notificationsPage, onboardingIssuedPage, tenantsPage } from '../ui/platform/console.js';
import { csrfFrom, userAgent } from './admin-routes.js';
import { OidcClient, OidcError } from './oidc.js';
import type { OnboardingTokenSummary, PlatformStore, PlatformTenant } from './platform-store.js';
import { RateLimiter } from './rate-limit.js';
import { bodyString, bodyText, queryString } from './request-input.js';
import type { GatewayStore, PlatformAuditEvent } from './store.js';
import {
  constantTimeEquals,
  CSRF_TOKEN_PREFIX,
  generateSecret,
  hashToken,
  ONBOARDING_TOKEN_PREFIX,
  PLATFORM_COOKIE_PREFIX,
} from './tokens.js';

export interface PlatformDeps {
  config: Config;
  store: GatewayStore;
  platformStore: PlatformStore;
  notifier: Notifier;
  now: () => Date;
  fetchImpl: FetchLike;
}

const COOKIE_NAME = 'renkei_platform';

/** Long enough for an IdP that asks for a second factor. */
const SIGN_IN_TTL_MS = 15 * 60 * 1000;

/**
 * Shorter than the tenant console's fifteen and four.
 *
 * `admin-routes.ts` argues down from the user-facing bounds because that console
 * can revoke every session a tenant has. This one can suspend every tenant and
 * repoint any tenant's operator authentication, so the same argument goes one
 * level further.
 */
const IDLE_MINUTES = 10;
const MAX_HOURS = 2;

const SIGN_IN_ATTEMPTS_PER_MINUTE = 10;

/** Matches the `tenants_slug_shape` constraint. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * How long an onboarding link lives.
 *
 * A day rather than an hour, matching site registration, because the realistic
 * path is the same shape: the holder has to go and create an application in
 * somebody else's system before they can finish. Risk is bounded by single-use,
 * the attempt ceiling, explicit revocation, and the notification body being purged
 * once the link is dead. A deployment that adds email delivery should shorten it —
 * a mailbox keeps what this console purges.
 */
const ONBOARDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Fixed strings, keyed by a token in the URL. Never the query text itself. */
const NOTICES: Record<string, string> = {
  'signed-out': 'Signed out.',
  created: 'Tenant created. Issue its operator an onboarding link so they can sign in.',
  'slug-taken': 'A tenant with that name already exists.',
  suspended: 'Suspended. Its endpoints and its console now answer as if it did not exist.',
  resumed: 'Resumed.',
  revoked: 'That link no longer works.',
  'revoke-failed': 'That link had already been used or withdrawn.',
  dismissed: 'Dismissed.',
};

/** What an authenticated platform request has resolved to. */
export interface PlatformContext {
  sessionId: string;
  subject: string;
  operator: string;
  csrfToken: string;
}

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const { config, store, platformStore, notifier, now, fetchImpl } = deps;
  const platformOidc = config.platformOidc;

  // Nothing is registered without a provider, so the surface does not exist rather
  // than existing and refusing. `src/app.ts` also guards; this is belt and braces
  // for a caller that constructs these routes directly.
  if (platformOidc === null) return;

  // Its own client, not one shared with the tenant console: a discovery cached on
  // this side must not become the entry an operator sign-in reads.
  const oidc = new OidcClient({ fetchImpl, now });
  const signInLimiter = new RateLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE, () => now().getTime());

  function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(body);
  }

  // ------------------------------------------------------------ the sign-in

  app.get('/platform', async (request, reply) => {
    const context = await authenticate(request);

    if (context === null) {
      clearCookie(reply);
      return html(
        reply,
        renderPage(
          platformSignInPage({ reason: NOTICES[queryString(request, 'done') ?? ''] ?? null }),
        ),
      );
    }

    // The door, not a page: every console page is suffixed, so this route's only
    // job stays "sign in, or go where you were going".
    return reply.redirect('/platform/tenants', 302);
  });

  app.get('/platform/sign-in', async (request, reply) => {
    if (!signInLimiter.check(request.ip).allowed) {
      return html(
        reply,
        errorPage('Too many attempts', 'Wait a minute and try signing in again.'),
        429,
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
      const provider = await oidc.discover(platformOidc.issuer);
      target = oidc.buildAuthorizeUrl(provider, platformOidc, {
        state: pending.state,
        nonce: pending.nonce,
        codeChallenge: challengeFor(verifier),
        redirectUri: platformOidc.redirectUri,
      });
    } catch (error) {
      return failSignIn(request, reply, error, 'failure');
    }

    // Stored only once the redirect is certain, so a broken configuration does not
    // accumulate rows nobody will redeem.
    await platformStore.putPlatformAuthorization(pending);

    return reply.redirect(target, 302);
  });

  app.get('/platform/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const state = query.state ?? '';

    // Consumed before anything else is checked, so a duplicated callback finds
    // nothing to work with.
    const pending = state === '' ? null : await platformStore.takePlatformAuthorization(state);

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
      return html(reply, errorPage('That took too long', 'Start the sign-in again.'), 400);
    }

    if (query.error !== undefined) {
      // Never echoed: the provider's own error string is for the log.
      return failSignIn(
        request,
        reply,
        new OidcError(
          `provider returned ${query.error}`,
          'Your identity provider did not complete the sign-in.',
        ),
        'denied',
      );
    }

    const code = query.code ?? '';
    if (code === '') {
      return failSignIn(
        request,
        reply,
        new OidcError('no code', 'Your identity provider returned no authorization code.'),
        'failure',
      );
    }

    let identity;
    try {
      const provider = await oidc.discover(platformOidc.issuer);
      const idToken = await oidc.exchangeCode(provider, platformOidc, {
        code,
        redirectUri: platformOidc.redirectUri,
        codeVerifier: pending.codeVerifier,
      });
      identity = await oidc.verifyIdToken(provider, platformOidc, idToken, pending.nonce);
    } catch (error) {
      const outcome: PlatformAuditEvent['outcome'] =
        error instanceof OidcError && error.message.includes('required role')
          ? 'denied'
          : 'failure';
      return failSignIn(request, reply, error, outcome);
    }

    const secret = generateSecret(PLATFORM_COOKIE_PREFIX);
    const issuedAt = now();

    await platformStore.createPlatformSession({
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

    await record(request, 'platform_sign_in', 'success', null);

    reply.header('set-cookie', serializeCookie(secret, MAX_HOURS * 3600));
    return reply.redirect('/platform', 302);
  });

  app.post('/platform/sign-out', async (request, reply) => {
    const context = await authenticate(request);
    // A signed-out sign-out redirects rather than 401ing: there is nothing to
    // protect and the person is trying to leave.
    if (context === null) return reply.redirect('/platform', 303);

    if (!constantTimeEquals(csrfFrom(request), context.csrfToken)) {
      return html(
        reply,
        errorPage('That form was out of date', 'Reload the page and try again.'),
        403,
      );
    }

    await platformStore.revokePlatformSession(context.sessionId, now().toISOString());
    clearCookie(reply);
    return reply.redirect('/platform?done=signed-out', 303);
  });

  // -------------------------------------------------------------- the tenants

  app.get('/platform/tenants', async (request, reply) => {
    const context = await authenticate(request);
    if (context === null) return reply.redirect('/platform', 302);

    return html(
      reply,
      renderPage(
        tenantsPage({
          context: consoleContext(context, 'tenants', request),
          tenants: await platformStore.listTenants(),
          canDeliver: notifier.channels.length > 0,
        }),
      ),
    );
  });

  app.post('/platform/tenants', async (request, reply) => {
    const context = await authorizeWrite(request, reply);
    if (context === null) return reply;

    const slug = bodyText(request, 'slug');
    const name = bodyText(request, 'name').trim();

    if (!SLUG.test(slug) || name === '') {
      return html(
        reply,
        errorPage(
          'That will not work as a tenant',
          'A slug is lowercase letters, numbers and dashes, and a name cannot be blank. The slug ' +
            'appears in the console URL and cannot be changed afterwards.',
        ),
        400,
      );
    }

    const created = await platformStore.createTenant(slug, name);

    if (created === null) {
      await record(request, 'platform_tenant_create', 'denied', null);
      return reply.redirect('/platform/tenants?done=slug-taken', 303);
    }

    await record(request, 'platform_tenant_create', 'success', created.id);
    return reply.redirect('/platform/tenants?done=created', 303);
  });

  app.post('/platform/tenants/status', async (request, reply) => {
    const context = await authorizeWrite(request, reply);
    if (context === null) return reply;

    const slug = bodyText(request, 'slug');
    const status = bodyText(request, 'status');

    /**
     * Both values are required literally, and neither direction is a default.
     *
     * The console's site toggle reads `enabled === 'true'`, where a malformed value
     * disables a site — the safe direction for an access gate. Here the equivalent
     * shortcut would suspend a live tenant on a typo, cutting off every one of its
     * users. A refusal is the only safe failure.
     */
    if (status !== 'suspended' && status !== 'active') {
      return html(reply, errorPage('That is not a status', 'Nothing was changed.'), 400);
    }

    const tenant = await platformStore.findTenantBySlug(slug);
    if (tenant === null) return notFound(reply);

    await platformStore.setTenantStatus(slug, status);
    await record(
      request,
      status === 'suspended' ? 'platform_tenant_suspend' : 'platform_tenant_resume',
      'success',
      tenant.id,
    );

    return reply.redirect(
      `/platform/tenants?done=${status === 'suspended' ? 'suspended' : 'resumed'}`,
      303,
    );
  });

  // ---------------------------------------------------------- onboarding links

  app.post('/platform/tenants/onboarding', async (request, reply) => {
    const context = await authorizeWrite(request, reply);
    if (context === null) return reply;

    const slug = bodyText(request, 'slug');
    const tenant = await platformStore.findTenantBySlug(slug);
    if (tenant === null) {
      await record(request, 'platform_onboarding_issued', 'denied', null);
      return notFound(reply);
    }

    const allowReplace = bodyString(request, 'allowReplace') === 'true';

    if (tenant.hasOidc && !allowReplace) {
      return html(
        reply,
        errorPage(
          'That tenant already has an identity provider',
          'A link only replaces one if you say so when issuing it — because a link that could ' +
            'silently repoint who operates a tenant is a link worth stealing. Issue it again with ' +
            'the replace box ticked if that is what you mean.',
        ),
        409,
      );
    }

    const secret = generateSecret(ONBOARDING_TOKEN_PREFIX);
    const expiresAt = new Date(now().getTime() + ONBOARDING_TTL_MS).toISOString();

    await platformStore.createOnboardingToken({
      tenantId: tenant.id,
      tokenHash: hashToken(secret),
      allowReplace,
      issuedBySubject: context.subject,
      expiresAt,
    });

    await record(request, 'platform_onboarding_issued', 'success', tenant.id);

    const link = `${base()}/onboard/${secret}`;
    const recipient = bodyText(request, 'recipient').trim();

    /**
     * Delivery is attempted after the token exists, and its failure is reported
     * rather than thrown. The link is rendered either way: by this point the
     * capability is live, and a page that said "issuing failed" would leave one in
     * existence that nobody was told about.
     */
    let delivery: { delivered: boolean; recipient: string; reason?: string } | null = null;

    if (recipient !== '' && notifier.channels.length > 0) {
      const result = await notifier.send({
        channel: 'console',
        recipient,
        subject: `Set up operator sign-in for ${tenant.name}`,
        body:
          `You have been asked to configure operator sign-in for ${tenant.name} in Renkei.\n\n` +
          `Open ${link}\n\n` +
          `The link works once and expires within 24 hours.`,
        tenantId: tenant.id,
      });

      delivery = result.delivered
        ? { delivered: true, recipient }
        : { delivered: false, recipient, reason: result.reason };
    }

    return html(
      reply,
      renderPage(
        onboardingIssuedPage({
          context: consoleContext(context, 'tenants', request),
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
          link,
          expiresAt,
          allowReplace,
          delivery,
        }),
      ),
    );
  });

  app.post('/platform/tenants/onboarding/revoke', async (request, reply) => {
    const context = await authorizeWrite(request, reply);
    if (context === null) return reply;

    const revoked = await platformStore.revokeOnboardingToken(
      bodyText(request, 'token'),
      now().toISOString(),
    );

    return reply.redirect(
      `/platform/notifications?done=${revoked ? 'revoked' : 'revoke-failed'}`,
      303,
    );
  });

  // ------------------------------------------------------------ notifications

  app.get('/platform/notifications', async (request, reply) => {
    const context = await authenticate(request);
    if (context === null) return reply.redirect('/platform', 302);

    const tenants = await platformStore.listTenants();
    const outstanding: { tenantSlug: string; tokens: OnboardingTokenSummary[] }[] = [];

    for (const tenant of tenants) {
      if (tenant.pendingOnboardingTokens === 0) continue;

      const tokens = (await platformStore.listOnboardingTokens(tenant.id)).filter(
        (token) =>
          token.redeemedAt === null &&
          token.revokedAt === null &&
          Date.parse(token.expiresAt) > now().getTime(),
      );
      if (tokens.length > 0) outstanding.push({ tenantSlug: tenant.slug, tokens });
    }

    return html(
      reply,
      renderPage(
        notificationsPage({
          context: consoleContext(context, 'notifications', request),
          notifications: await platformStore.listNotifications(50),
          outstanding,
        }),
      ),
    );
  });

  app.post('/platform/notifications/ack', async (request, reply) => {
    const context = await authorizeWrite(request, reply);
    if (context === null) return reply;

    await platformStore.acknowledgeNotification(
      bodyText(request, 'notification'),
      now().toISOString(),
    );
    return reply.redirect('/platform/notifications?done=dismissed', 303);
  });

  // ------------------------------------------------------------------ the gate

  async function authenticate(request: FastifyRequest): Promise<PlatformContext | null> {
    const secret = readCookie(request);
    if (secret === null) return null;

    const session = await platformStore.findPlatformSession(hashToken(secret));
    if (session === null || session.revokedAt !== null) return null;

    const at = now().getTime();
    if (Date.parse(session.expiresAt) <= at) return null;
    if (at - Date.parse(session.lastSeenAt) > IDLE_MINUTES * 60_000) return null;

    // After every check, so an idle-expired session is never refreshed into life.
    await platformStore.touchPlatformSession(session.id, new Date(at).toISOString());

    return {
      sessionId: session.id,
      subject: session.subject,
      operator: session.displayName ?? session.subject,
      csrfToken: session.csrfToken,
    };
  }

  /** Authentication plus CSRF. Answers the reply itself and returns null. */
  async function authorizeWrite(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PlatformContext | null> {
    const context = await authenticate(request);

    if (context === null) {
      clearCookie(reply);
      html(
        reply,
        errorPage('Your session ended', 'Sign in again to make that change. Nothing was changed.'),
        401,
      );
      return null;
    }

    if (!constantTimeEquals(csrfFrom(request), context.csrfToken)) {
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

  function consoleContext(
    context: PlatformContext,
    here: PlatformConsoleContext['here'],
    request: FastifyRequest,
  ): PlatformConsoleContext {
    return {
      operator: context.operator,
      csrfToken: context.csrfToken,
      here,
      notice: NOTICES[queryString(request, 'done') ?? ''] ?? null,
    };
  }

  function notFound(reply: FastifyReply): FastifyReply {
    return html(reply, renderPage(noPlatformConsolePage()), 404);
  }

  async function failSignIn(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    outcome: PlatformAuditEvent['outcome'],
  ): Promise<FastifyReply> {
    request.log.warn({ err: error }, 'platform sign-in failed');
    await record(request, 'platform_sign_in', outcome, null);

    const detail =
      error instanceof OidcError
        ? error.detail
        : 'Something went wrong completing the sign-in. Try again.';

    return html(reply, errorPage('Could not sign you in', detail), 403);
  }

  /**
   * Through the application store, because `platform_audit_log` is write-only to
   * `renkei_app` and unreachable by the platform role. Swallowed on failure: an
   * unwritable log must not break a sign-in.
   */
  function record(
    request: FastifyRequest,
    event: PlatformAuditEvent['event'],
    outcome: PlatformAuditEvent['outcome'],
    targetTenantId: string | null,
  ): Promise<void> {
    return store
      .writePlatformAuditEvent({
        event,
        outcome,
        sourceIp: request.ip === '' ? null : request.ip,
        userAgent: userAgent(request),
        requestPath: request.url.split('?')[0] ?? null,
        targetTenantId,
        // An IdP subject is not an Atlassian account, and this column means the
        // latter. Conflating them would make it mean two things.
        accountId: null,
      })
      .catch((cause: unknown) => {
        request.log.warn({ err: cause, event }, 'could not record a platform event');
      });
  }

  function base(): string {
    return config.publicBaseUrl.replace(/\/+$/, '');
  }

  // ------------------------------------------------------------------ cookies

  /**
   * `Path=/platform`, so it is never sent to a tenant console or to `/mcp`.
   *
   * A bare secret rather than the portal's `<id>.<secret>`: there is no tenant to
   * recover before the lookup can run.
   */
  function serializeCookie(value: string, maxAgeSeconds: number): string {
    const parts = [
      `${COOKIE_NAME}=${value}`,
      'Path=/platform',
      'HttpOnly',
      // Lax rather than Strict: the IdP returns here as a cross-site redirect, and
      // Strict would drop the cookie on exactly that navigation. Every form
      // carries a CSRF token besides.
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];

    // Derived rather than configured: a Secure cookie is silently dropped over
    // plain HTTP, which would make local development mysteriously never sign in.
    if (config.publicBaseUrl.startsWith('https://')) parts.push('Secure');

    return parts.join('; ');
  }

  function clearCookie(reply: FastifyReply): void {
    reply.header('set-cookie', serializeCookie('', 0));
  }
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

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Exposed so the onboarding routes can describe the callbacks a tenant must register. */
export function operatorCallbackUris(
  config: Config,
  slug: string,
): { console: string; device: string } {
  const base = config.publicBaseUrl.replace(/\/+$/, '');
  return {
    console: `${base}/admin/${slug}/callback`,
    device: `${base}/auth/device/${slug}/callback`,
  };
}

export type { PlatformTenant, PlatformOidcConfig };
