/**
 * `/onboard/<token>` — a tenant operator configuring their own identity provider.
 *
 * The last link in a chain that used to require database access: a platform
 * operator issues a one-time link, whoever holds it points Renkei at their
 * organization's provider, and from that moment the tenant's operators can sign in
 * at `/admin/<slug>` and register a Jira site. No CLI, no `psql`.
 *
 * **No session, and the token is the whole authorization.** There is no cookie to
 * set and nothing to authenticate against — the point of the flow is that the
 * person on the other end has no account yet. The unguessable single-use secret in
 * the URL is what stands in, and it goes into a hidden field on the form for the
 * same reason the device-approval page carries its approval token: a second secret
 * would protect nothing the first does not.
 *
 * **Runs on the application role, not the platform one.** The token row carries its
 * `tenant_id`, so once the secret resolves, everything else happens through
 * `store.admin(tenantId)`, which sets `renkei.tenant_id` and is confined by
 * row-level security to that one tenant. `renkei_app` has SELECT and UPDATE on
 * the token table and no INSERT: the platform role mints capabilities and this one
 * spends them, and neither can do the other's half.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '../auth/atlassian.js';
import type { Config } from '../config.js';
import { errorPage, renderPage } from '../ui/render.js';
import {
  onboardingDonePage,
  onboardingFormPage,
  onboardingRefusedPage,
} from '../ui/onboarding/pages.js';
import { userAgent } from './admin-routes.js';
import { OidcClient, OidcError } from './oidc.js';
import { operatorCallbackUris } from './platform-routes.js';
import { RateLimiter } from './rate-limit.js';
import { bodyString, bodyText } from './request-input.js';
import type { GatewayStore, OnboardingToken, PlatformAuditEvent } from './store.js';
import { hashToken } from './tokens.js';

export interface OnboardingDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

/**
 * Failed redemptions before a link is dead.
 *
 * A typo must not burn the token — that would be a denial of service against the
 * tenant, and the whole reason this flow reads rather than consumes. A ceiling is
 * what keeps that allowance from becoming something to grind against.
 */
const MAX_ATTEMPTS = 10;

const ATTEMPTS_PER_MINUTE = 10;

/**
 * The audit path for these routes, as a literal.
 *
 * Every other caller passes `request.url.split('?')[0]`, whose comment says "a
 * path, never a query string — that is where tokens end up". That reasoning is
 * exactly inverted here, because this secret travels *in the path*. Recording the
 * real URL would write a live capability into `platform_audit_log`, which is the
 * one table the application can write and never read back to notice.
 */
const AUDIT_PATH = '/onboard';

export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingDeps): void {
  const { config, store, now, fetchImpl } = deps;
  const oidc = new OidcClient({ fetchImpl, now });
  const limiter = new RateLimiter(ATTEMPTS_PER_MINUTE, () => now().getTime());

  function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(body);
  }

  /** One answer for every dead-token reason — see `onboardingRefusedPage`. */
  function refused(reply: FastifyReply): FastifyReply {
    return html(reply, renderPage(onboardingRefusedPage()), 404);
  }

  /**
   * Resolves a secret to a live token, or null.
   *
   * Reads rather than consumes: this is a capability being exercised
   * interactively, unlike a `state`, which is a replay handle for a flow that has
   * already left the browser and must burn even on failure.
   */
  async function live(secret: string): Promise<OnboardingToken | null> {
    if (secret === '') return null;

    const token = await store.findOnboardingToken(hashToken(secret));

    if (
      token === null ||
      token.redeemedAt !== null ||
      token.revokedAt !== null ||
      token.attempts >= MAX_ATTEMPTS ||
      Date.parse(token.expiresAt) <= now().getTime()
    ) {
      return null;
    }

    return token;
  }

  app.get('/onboard/:token', async (request, reply) => {
    const { token: secret } = request.params as { token: string };
    const token = await live(secret);
    if (token === null) return refused(reply);

    const admin = store.admin(token.tenantId);
    const tenant = await admin.getTenant();
    if (tenant === null) return refused(reply);

    const callbacks = operatorCallbackUris(config, tenant.slug);
    const existing = await admin.getOidc();

    // A no-replace link against a tenant that has since been configured is dead in
    // the same way an expired one is, and says so the same way.
    if (existing !== null && !token.allowReplace) return refused(reply);

    return html(
      reply,
      renderPage(
        onboardingFormPage({
          token: secret,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
          consoleCallback: callbacks.console,
          deviceCallback: callbacks.device,
          replacing: existing !== null,
          error: null,
          values: { issuer: '', clientId: '', roleClaim: 'roles', requiredRole: '' },
        }),
      ),
    );
  });

  app.post('/onboard', async (request, reply) => {
    if (!limiter.check(request.ip).allowed) {
      return html(reply, errorPage('Too many attempts', 'Wait a minute and try again.'), 429);
    }

    const secret = bodyText(request, 'token');
    const token = await live(secret);
    if (token === null) return refused(reply);

    const admin = store.admin(token.tenantId);
    const tenant = await admin.getTenant();
    if (tenant === null) return refused(reply);

    const callbacks = operatorCallbackUris(config, tenant.slug);
    const existing = await admin.getOidc();
    if (existing !== null && !token.allowReplace) return refused(reply);

    const issuer = bodyText(request, 'issuer').trim();
    const clientId = bodyText(request, 'clientId').trim();
    const clientSecret = bodyText(request, 'clientSecret');
    const roleClaim = bodyText(request, 'roleClaim').trim() || 'roles';
    const requiredRoleRaw = bodyText(request, 'requiredRole').trim();
    const requiredRole = requiredRoleRaw === '' ? null : requiredRoleRaw;
    const acceptedOpenGroup = bodyString(request, 'acceptOpenRole') === 'true';

    /** Re-renders the form with everything but the secret preserved. */
    const again = async (message: string): Promise<FastifyReply> => {
      await store.recordOnboardingAttempt(hashToken(secret));
      await record(request, 'tenant_onboarding_redeemed', 'failure', token.tenantId);

      return html(
        reply,
        renderPage(
          onboardingFormPage({
            token: secret,
            tenantName: tenant.name,
            tenantSlug: tenant.slug,
            consoleCallback: callbacks.console,
            deviceCallback: callbacks.device,
            replacing: existing !== null,
            error: message,
            // The four non-secret fields come back, so one typo does not cost the
            // other four. The client secret never round-trips into HTML.
            values: { issuer, clientId, roleClaim, requiredRole: requiredRoleRaw },
          }),
        ),
        400,
      );
    };

    if (issuer === '' || clientId === '' || clientSecret === '') {
      return again('An issuer, a client ID and a client secret are all required.');
    }

    if (requiredRole === null && !acceptedOpenGroup) {
      // The CLI writes a warning nobody reads; here it is a decision somebody has
      // to make on purpose.
      return again(
        'Without an operator role, every subject your provider authenticates can operate this ' +
          'tenant. Name a group, or tick the box to say you mean it.',
      );
    }

    /**
     * The provider is checked before anything is written.
     *
     * `discover` compares the document's own `issuer` to this one for exact
     * equality, so the classic trailing-slash mistake fails here, at configuration
     * time, with a message naming both strings — rather than at the operator's
     * first sign-in, by which time nobody is looking at this form. A failed
     * discovery is not cached, so fixing the provider and retrying is not blocked
     * by the ten-minute TTL.
     */
    try {
      await oidc.discover(issuer);
    } catch (error) {
      request.log.warn({ err: error }, 'onboarding discovery failed');
      return again(
        error instanceof OidcError
          ? error.detail
          : 'Renkei could not reach that issuer. Check the URL and try again.',
      );
    }

    // Only now is the capability spent. Conditional on the same predicates `live`
    // checked, so two concurrent submissions cannot both win.
    const redeemed = await store.redeemOnboardingToken(hashToken(secret), now().toISOString());
    if (redeemed === null) return refused(reply);

    await admin.putOidc({
      // Verbatim. Normalizing a trailing slash away is the one edit that
      // guarantees the exact-equality check above can never pass again.
      issuer,
      clientId,
      clientSecret,
      roleClaim,
      requiredRole,
    });

    // Invalidate cached discovery and JWKS so new credentials take effect immediately.
    oidc.invalidateCache(issuer);

    if (existing !== null) {
      /**
       * Every live operator session for this tenant was minted under a provider
       * that no longer authenticates it. Leaving them signed in would mean a
       * replaced IdP takes effect only at the next sign-in, which is the same
       * "live session behind a changed credential" the console avoids when it
       * deletes a stored grant.
       */
      await admin.revokeAllOperatorSessions(now().toISOString());
      await record(request, 'tenant_oidc_replaced', 'success', token.tenantId);
    }

    await record(request, 'tenant_onboarding_redeemed', 'success', token.tenantId);

    return html(
      reply,
      renderPage(
        onboardingDonePage({
          tenantName: tenant.name,
          consoleUrl: `${config.publicBaseUrl.replace(/\/+$/, '')}/admin/${tenant.slug}`,
        }),
      ),
    );
  });

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
        // The literal, never the real URL — see AUDIT_PATH.
        requestPath: AUDIT_PATH,
        targetTenantId,
        accountId: null,
      })
      .catch((cause: unknown) => {
        request.log.warn({ err: cause, event }, 'could not record an onboarding event');
      });
  }
}
