/**
 * `/` and `/create-organization` — self-service onboarding.
 *
 * The primary path for every deployment shape now, registered unconditionally
 * (see app.ts): type a work email, and either land on your organization's own
 * sign-in (home-realm discovery, keyed by `tenant_domains`' globally unique
 * `domain` column) or walk through creating one.
 *
 * Creating an organization needs a brand-new tenant, which is a privileged
 * operation under row-level security the same way it always was — but rather
 * than inventing a new way around that, this reuses `PlatformStore.createTenant`,
 * the exact method `POST /platform/tenants` already calls on the `renkei_platform`
 * role. Once that succeeds, everything else (writing `tenant_oidc`, claiming the
 * domain, seeding playbooks) goes through the `AdminStore` a bare tenant ID
 * gets from `store.admin(tenantId)` — no `TenantContext` needed, because none
 * of that is scoped to a site.
 *
 * Domain ownership is proved, not asserted: after configuring an OIDC issuer,
 * the person has to actually complete a login through it, and the tenant only
 * commits if the returned id_token's verified email ends in the claimed
 * domain. A mismatch, an expired flow, or a slug collision all mean starting
 * over from `/create-organization` — the pending row is single-use, deleted
 * on the first callback whether it succeeds or not, so there is nothing
 * partial to resume.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { FetchLike } from '../auth/atlassian.js';
import type { Config } from '../config.js';
import { decrypt, encrypt, parseEncryptionKey } from '../crypto/secretbox.js';
import { errorPage, renderPage } from '../ui/render.js';
import {
  configureIdpPage,
  domainConflictPage,
  domainMismatchPage,
  homeRealmPage,
  organizationFormPage,
  slugTakenPage,
  suspendedPage,
} from '../ui/wizard/pages.js';
import { mintOperatorSession } from './admin-routes.js';
import { OidcClient, OidcError, type OidcConfig } from './oidc.js';
import { PLAYBOOK_SEEDS } from './playbook-seeds.js';
import type { PlatformStore } from './platform-store.js';
import { RateLimiter } from './rate-limit.js';
import { bodyString, bodyText, queryString, queryStrings } from './request-input.js';
import type { GatewayStore } from './store.js';
import { generateSecret } from './tokens.js';
import { createHash } from 'node:crypto';

export interface WizardDeps {
  config: Config;
  store: GatewayStore;
  /**
   * Absent only in a test harness that has no reason to exercise tenant
   * creation — every real deployment always opens one now (src/server.ts).
   * Home-realm discovery and the early wizard steps work regardless; only
   * the final commit in `/create-organization/callback` needs it.
   */
  platformStore?: PlatformStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

/** Long enough for an IdP that asks for a second factor. Matches admin-routes.ts's sign-in TTL. */
const SIGNUP_TTL_MS = 15 * 60 * 1000;

const HOME_REALM_ATTEMPTS_PER_MINUTE = 10;
const CREATE_ORG_ATTEMPTS_PER_MINUTE = 10;

/** Matches the `tenant_domains_domain_shape` constraint. */
const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function html(reply: FastifyReply, body: string, status = 200): FastifyReply {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(body);
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return DOMAIN_SHAPE.test(domain) ? domain : null;
}

/**
 * A candidate slug from an org name — lowercase, `[a-z0-9-]`, collapsed and
 * trimmed to fit `tenants_slug_shape` (2-63 chars, starting alphanumeric).
 * Never reserved by deriving it; `PlatformStore.createTenant` is what decides
 * whether it is actually available.
 */
function deriveSlug(orgName: string): string {
  const base = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  if (base.length >= 2) return base;

  // A name with no usable characters at all (e.g. all punctuation, or a
  // single character) — fall back to something guaranteed to fit the shape
  // rather than handing PlatformStore.createTenant a string that always fails.
  return `org-${generateSecret('').slice(0, 8).toLowerCase()}`;
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function wizardCallbackUri(config: Config): string {
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/create-organization/callback`;
}

export function registerWizardRoutes(app: FastifyInstance, deps: WizardDeps): void {
  const { config, store, platformStore, now, fetchImpl } = deps;
  const oidc = new OidcClient({ fetchImpl, now });
  const homeRealmLimiter = new RateLimiter(HOME_REALM_ATTEMPTS_PER_MINUTE, () => now().getTime());
  const createOrgLimiter = new RateLimiter(CREATE_ORG_ATTEMPTS_PER_MINUTE, () => now().getTime());

  // ------------------------------------------------------ home-realm discovery

  app.get('/', (_request, reply) => html(reply, renderPage(homeRealmPage({}))));

  app.post('/', async (request, reply) => {
    if (!homeRealmLimiter.check(request.ip).allowed) {
      return html(reply, errorPage('Too many attempts', 'Wait a minute and try again.'), 429);
    }

    const email = bodyText(request, 'email').trim().toLowerCase();
    const domain = emailDomain(email);

    if (domain === null) {
      return html(reply, renderPage(homeRealmPage({ notice: 'Enter a valid work email.' })), 400);
    }

    const resolved = await store.resolveDomain(domain);

    if (resolved === null) {
      return reply.redirect(`/create-organization?domain=${encodeURIComponent(domain)}`, 302);
    }

    if (!resolved.active) {
      return html(reply, renderPage(suspendedPage({ orgName: resolved.slug })));
    }

    return reply.redirect(`/admin/${resolved.slug}`, 302);
  });

  // ------------------------------------------------------- create-organization

  app.get('/create-organization', (request, reply) => {
    const domain = queryString(request, 'domain') ?? '';
    return html(reply, renderPage(organizationFormPage({ orgName: '', domain, error: null })));
  });

  app.post('/create-organization', async (request, reply) => {
    if (platformStore === undefined) {
      return html(
        reply,
        errorPage(
          'Not available',
          'Self-service sign-up is not available on this deployment. Ask whoever runs it to ' +
            'create your organization.',
        ),
        500,
      );
    }

    if (!createOrgLimiter.check(request.ip).allowed) {
      return html(reply, errorPage('Too many attempts', 'Wait a minute and try again.'), 429);
    }

    const orgName = bodyText(request, 'orgName').trim();
    const domain = bodyText(request, 'domain').trim().toLowerCase();

    const again = (error: string): FastifyReply =>
      html(reply, renderPage(organizationFormPage({ orgName, domain, error })), 400);

    if (orgName === '') return again('An organization name is required.');
    if (!DOMAIN_SHAPE.test(domain)) return again('Enter a domain, e.g. acme.com.');

    const existing = await store.resolveDomain(domain);
    if (existing !== null) {
      return again('That domain already belongs to an organization here — sign in instead.');
    }

    return html(
      reply,
      renderPage(
        configureIdpPage({
          orgName,
          domain,
          slug: deriveSlug(orgName),
          callbackUri: wizardCallbackUri(config),
          error: null,
          values: { issuer: '', clientId: '', roleClaim: 'roles', requiredRole: '' },
        }),
      ),
    );
  });

  app.post('/create-organization/idp', async (request, reply) => {
    const orgName = bodyText(request, 'orgName').trim();
    const domain = bodyText(request, 'domain').trim().toLowerCase();
    const slug = bodyText(request, 'slug').trim();

    if (orgName === '' || !DOMAIN_SHAPE.test(domain) || slug === '') {
      // The hidden fields were tampered with or dropped — back to step one
      // rather than trying to render a form with nothing to put in it.
      return reply.redirect('/create-organization', 302);
    }

    const issuer = bodyText(request, 'issuer').trim();
    const clientId = bodyText(request, 'clientId').trim();
    const clientSecret = bodyText(request, 'clientSecret');
    const roleClaim = bodyText(request, 'roleClaim').trim() || 'roles';
    const requiredRoleRaw = bodyText(request, 'requiredRole').trim();
    const requiredRole = requiredRoleRaw === '' ? null : requiredRoleRaw;
    const acceptedOpenGroup = bodyString(request, 'acceptOpenRole') === 'true';

    const again = (error: string): FastifyReply =>
      html(
        reply,
        renderPage(
          configureIdpPage({
            orgName,
            domain,
            slug,
            callbackUri: wizardCallbackUri(config),
            error,
            values: { issuer, clientId, roleClaim, requiredRole: requiredRoleRaw },
          }),
        ),
        400,
      );

    if (issuer === '' || clientId === '' || clientSecret === '') {
      return again('An issuer, a client ID and a client secret are all required.');
    }

    if (requiredRole === null && !acceptedOpenGroup) {
      return again(
        'Without an operator role, every subject your provider authenticates can operate this ' +
          'organization. Name a group, or tick the box to say you mean it.',
      );
    }

    // Checked before anything is written — the same fail-fast discovery
    // /onboard performs, for the same reason: a mistyped issuer belongs at
    // configuration time, not at the first sign-in.
    let provider;
    try {
      provider = await oidc.discover(issuer);
    } catch (error) {
      request.log.warn({ err: error }, 'wizard discovery failed');
      return again(
        error instanceof OidcError
          ? error.detail
          : 'Renkei could not reach that issuer. Check the URL and try again.',
      );
    }

    const verifier = generateSecret('');
    const state = generateSecret('');
    const nonce = generateSecret('');

    await store.putPendingOrgSignup({
      state,
      nonce,
      codeVerifier: verifier,
      slug,
      orgName,
      domain,
      issuer,
      clientId,
      encryptedClientSecret: encrypt(clientSecret, parseEncryptionKey(config.tokenEncryptionKey)),
      roleClaim,
      requiredRole,
      expiresAt: new Date(now().getTime() + SIGNUP_TTL_MS).toISOString(),
    });

    const target = oidc.buildAuthorizeUrl(
      provider,
      { issuer, clientId, clientSecret, roleClaim, requiredRole },
      {
        state,
        nonce,
        codeChallenge: challengeFor(verifier),
        redirectUri: wizardCallbackUri(config),
      },
    );

    return reply.redirect(target, 302);
  });

  app.get('/create-organization/callback', async (request, reply) => {
    const query = queryStrings(request);
    const state = query.state ?? '';

    const pending = state === '' ? null : await store.takePendingOrgSignup(state);

    if (pending === null) {
      return html(
        reply,
        errorPage(
          'Nothing to complete',
          'This sign-in link has already been used, has expired, or did not originate here. ' +
            'Start again from Create your organization.',
        ),
        400,
      );
    }

    if (Date.parse(pending.expiresAt) <= now().getTime()) {
      return html(
        reply,
        errorPage('That took too long', 'The sign-in expired. Start again from the beginning.'),
        400,
      );
    }

    if (query.error !== undefined) {
      return html(
        reply,
        errorPage(
          'Sign-in failed',
          'Your identity provider did not complete the sign-in. If you declined the prompt, ' +
            'start again and approve it.',
        ),
        400,
      );
    }

    const code = query.code ?? '';
    if (code === '') {
      return html(
        reply,
        errorPage('Missing authorization code', 'Your identity provider returned no code.'),
        400,
      );
    }

    const clientSecret = decrypt(
      pending.encryptedClientSecret,
      parseEncryptionKey(config.tokenEncryptionKey),
    );
    const oidcConfig: OidcConfig = {
      issuer: pending.issuer,
      clientId: pending.clientId,
      clientSecret,
      roleClaim: pending.roleClaim,
      requiredRole: pending.requiredRole,
    };

    let identity;
    try {
      const provider = await oidc.discover(pending.issuer);
      const idToken = await oidc.exchangeCode(provider, oidcConfig, {
        code,
        redirectUri: wizardCallbackUri(config),
        codeVerifier: pending.codeVerifier,
      });
      identity = await oidc.verifyIdToken(provider, oidcConfig, idToken, pending.nonce);
    } catch (error) {
      const message =
        error instanceof OidcError
          ? error.detail
          : 'Renkei could not complete the sign-in. Start again.';
      return html(reply, errorPage('Sign-in failed', message), 400);
    }

    const signedInDomain = identity.email === null ? null : emailDomain(identity.email);

    if (
      identity.emailVerified === false ||
      signedInDomain === null ||
      signedInDomain !== pending.domain
    ) {
      return html(
        reply,
        renderPage(domainMismatchPage({ domain: pending.domain, signedInEmail: identity.email })),
        400,
      );
    }

    if (platformStore === undefined) {
      // Reachable only if the deployment's platform role was removed mid-flow —
      // checked again here as a backstop, since `POST /create-organization`
      // already refuses to start a flow without one.
      return html(
        reply,
        errorPage('Not available', 'Self-service sign-up is no longer available. Try again later.'),
        500,
      );
    }

    const created = await platformStore.createTenant(pending.slug, pending.orgName);
    if (created === null) {
      return html(reply, renderPage(slugTakenPage({ orgName: pending.orgName })), 409);
    }

    const admin = store.admin(created.id);

    await admin.putOidc({
      issuer: pending.issuer,
      clientId: pending.clientId,
      clientSecret,
      roleClaim: pending.roleClaim,
      requiredRole: pending.requiredRole,
    });

    // Invalidate cached discovery and JWKS so new credentials take effect immediately.
    oidc.invalidateCache(pending.issuer);

    const claimed = await admin.claimDomain(pending.domain);

    for (const seed of PLAYBOOK_SEEDS) {
      await admin.putPlaybook(seed);
    }

    if (!claimed) {
      // Extremely rare: the tenant and its IdP are real and usable, only the
      // domain lost a race to another signup in the last few seconds. Not
      // rolled back — the operator can sign in and try a different domain,
      // or reach for pnpm tenant to sort it out, same as a bootstrap.ts
      // conflict always required.
      return html(reply, renderPage(domainConflictPage({ domain: pending.domain })), 409);
    }

    const cookie = await mintOperatorSession(admin, identity, config, pending.slug, now);
    reply.header('set-cookie', cookie);
    return reply.redirect(`/admin/${pending.slug}/onboard-site`, 302);
  });
}
