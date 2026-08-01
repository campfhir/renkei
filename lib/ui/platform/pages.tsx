/**
 * The platform console's chrome and its unauthenticated pages.
 *
 * Same rule as the tenant console: every page takes plain data, never a store, so
 * no page can decide to go and read something. What this console may know is
 * settled at the route by the shape of `PlatformStore` and settled again here by
 * the shape of these props — and `PlatformStore` deliberately cannot reach a site
 * list, a user list, an audit row, or a tenant's IdP secret.
 */

import type { ReactNode } from 'react';
import { Csrf, Page } from '../layout.js';

/** Where the console's own links point, and which tab is current. */
export interface PlatformConsoleContext {
  /** The IdP subject's display name, or the subject itself. */
  operator: string;
  csrfToken: string;
  here: 'tenants' | 'notifications';
  notice?: string | null;
  warning?: string | null;
}

const TABS = [
  { key: 'tenants', label: 'Tenants', path: '/tenants' },
  { key: 'notifications', label: 'Notifications', path: '/notifications' },
] as const;

function Nav({ context }: { context: PlatformConsoleContext }): ReactNode {
  return (
    <nav>
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={`/platform${tab.path}`}
          className={tab.key === context.here ? 'here' : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

/** The chrome every signed-in platform page shares. */
export function PlatformConsolePage({
  context,
  heading,
  children,
}: {
  context: PlatformConsoleContext;
  heading: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Page
      title="Renkei — platform"
      heading={heading}
      subheading={`Platform operator · signed in as ${context.operator}`}
      width="52rem"
      nav={<Nav context={context} />}
    >
      {context.notice === undefined || context.notice === null ? null : (
        <p className="notice">{context.notice}</p>
      )}
      {context.warning === undefined || context.warning === null ? null : (
        <p className="warn">{context.warning}</p>
      )}
      {children}
      <form method="post" action="/platform/sign-out" style={{ margin: '2.5rem 0 0' }}>
        <Csrf token={context.csrfToken} />
        <button type="submit">Sign out</button>
      </form>
    </Page>
  );
}

/**
 * The unauthenticated door.
 *
 * Names no tenant and counts nothing. Unlike `/admin/<slug>`, this address
 * discloses only that the deployment has a platform console — which anybody who
 * can read the documentation already knows.
 */
export function platformSignInPage(options: { reason: string | null }): ReactNode {
  return (
    <Page title="Renkei — platform sign-in" heading="Renkei platform console">
      {options.reason === null ? null : <p className="warn">{options.reason}</p>}
      <p>
        Sign in with the deployment’s identity provider. Whether you are a platform operator is
        decided by a role claim there, so access is granted and removed in that provider rather than
        in Renkei.
      </p>
      <p>
        <a className="btn primary" href="/platform/sign-in">
          Sign in
        </a>
      </p>
      <p className="muted">
        This console creates tenants and hands each one to its own operator. It cannot read a
        tenant’s sites, users, audit log, or stored credentials.
      </p>
    </Page>
  );
}

/**
 * What an unconfigured deployment answers.
 *
 * Rendered rather than 404'd only where the route exists at all; with no platform
 * IdP configured, the routes are never registered and Fastify's own not-found
 * handler answers instead. This covers the narrower case of a console that exists
 * but cannot complete a sign-in.
 */
export function noPlatformConsolePage(): ReactNode {
  return (
    <Page title="Renkei" heading="No platform console here" tone="problem">
      <p>
        This deployment has no platform identity provider configured, so there is nothing to sign in
        against. Whoever runs it sets <code>PLATFORM_OIDC_ISSUER</code>,{' '}
        <code>PLATFORM_OIDC_CLIENT_ID</code>, <code>PLATFORM_OIDC_CLIENT_SECRET</code> and{' '}
        <code>PLATFORM_OIDC_REQUIRED_ROLE</code>.
      </p>
    </Page>
  );
}
