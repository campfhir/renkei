/**
 * The operator console's pages.
 *
 * Every page takes plain data — never a store — so there is no page that could
 * decide to go and read something. What the console is allowed to know is
 * settled at the route by the shape of `AdminStore`, and settled again here by
 * the shape of these props.
 */

import type { ReactNode } from 'react';
import { Csrf, Page, Section } from '../layout.js';
import type { TenantSummary } from '../../gateway/admin-store.js';

/** Where the console's own links point. Always tenant-prefixed. */
export interface ConsoleContext {
  tenant: TenantSummary;
  /** The IdP subject's display name, or the subject itself. */
  operator: string;
  csrfToken: string;
  /** Which nav entry is current. */
  here: 'sites' | 'people' | 'audit' | 'settings' | 'playbooks' | 'logs';
  notice?: string | null;
  warning?: string | null;
}

const TABS = [
  { key: 'sites', label: 'Sites', path: '/sites' },
  { key: 'people', label: 'People & sessions', path: '/people' },
  { key: 'playbooks', label: 'Playbooks', path: '/playbooks' },
  { key: 'audit', label: 'Audit log', path: '/audit' },
  { key: 'logs', label: 'Error logs', path: '/logs' },
  { key: 'settings', label: 'Settings', path: '/settings' },
] as const;

function base(tenant: TenantSummary): string {
  return `/admin/${tenant.slug}`;
}

function Nav({ context }: { context: ConsoleContext }): ReactNode {
  return (
    <nav>
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={`${base(context.tenant)}${tab.path}`}
          className={tab.key === context.here ? 'here' : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

/** The chrome every signed-in console page shares. */
export function ConsolePage({
  context,
  heading,
  children,
}: {
  context: ConsoleContext;
  heading: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Page
      title={`Renkei — ${context.tenant.name}`}
      heading={heading}
      subheading={`${context.tenant.name} · signed in as ${context.operator}`}
      width="52rem"
      nav={<Nav context={context} />}
    >
      {context.tenant.status === 'suspended' ? (
        <p className="warn">This tenant is suspended. Its endpoints are refusing requests.</p>
      ) : null}
      {context.notice === undefined || context.notice === null ? null : (
        <p className="notice">{context.notice}</p>
      )}
      {context.warning === undefined || context.warning === null ? null : (
        <p className="warn">{context.warning}</p>
      )}
      {children}
      <form
        method="post"
        action={`${base(context.tenant)}/sign-out`}
        style={{ margin: '2.5rem 0 0' }}
      >
        <Csrf token={context.csrfToken} />
        <button type="submit">Sign out</button>
      </form>
    </Page>
  );
}

/**
 * The unauthenticated console door.
 *
 * Says the tenant's name, because the slug is already in the URL the operator
 * typed and pretending otherwise would only make a mistyped slug harder to spot.
 * Says nothing about the tenant's sites, users, or IdP.
 */
export function operatorSignInPage(options: {
  slug: string;
  tenantName: string;
  reason: string | null;
  /** False when no platform operator has configured an IdP for this tenant. */
  configured: boolean;
}): ReactNode {
  return (
    <Page title="Renkei — operator sign-in" heading={`${options.tenantName} — operator console`}>
      {options.reason === null ? null : <p className="warn">{options.reason}</p>}
      {options.configured ? (
        <>
          <p>
            Sign in with your organization’s identity provider. Whether you are an operator here is
            decided by a role claim in that provider, so access is granted and removed there rather
            than in Renkei.
          </p>
          <p>
            <a className="btn primary" href={`/admin/${options.slug}/sign-in`}>
              Sign in
            </a>
          </p>
        </>
      ) : (
        <p>
          No identity provider is configured for this tenant yet, so there is no way to sign in. The
          platform operator who created the tenant sets one with <code>pnpm tenant set-oidc</code>.
        </p>
      )}
    </Page>
  );
}

/**
 * Where a CLI sign-in starts: type the code your terminal printed.
 *
 * A form rather than a link the CLI could pre-fill. The code travelling by hand
 * is what makes the next page meaningful — an operator who did not just run
 * `renkei admin login` has nothing to type, and so cannot be walked through a
 * flow they never started.
 */
export function deviceCodePage(options: {
  slug: string;
  tenantName: string;
  reason: string | null;
  configured: boolean;
}): ReactNode {
  return (
    <Page title="Renkei — authorize a device" heading={`${options.tenantName} — authorize a CLI`}>
      {options.reason === null ? null : <p className="warn">{options.reason}</p>}
      {options.configured ? (
        <>
          <p>
            Enter the code shown in your terminal. If you did not just start a sign-in from a
            command line, close this page — there is nothing here to approve.
          </p>
          <form method="get" action={`/auth/device/${options.slug}`}>
            <p>
              <label htmlFor="code">Code from your terminal</label>
              <br />
              <input
                id="code"
                name="code"
                className="mono"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                size={12}
                required
              />
            </p>
            <button type="submit" className="primary">
              Continue
            </button>
          </form>
        </>
      ) : (
        <p>
          No identity provider is configured for this tenant yet, so there is no way to sign in. The
          platform operator who created the tenant sets one with <code>pnpm tenant set-oidc</code>.
        </p>
      )}
    </Page>
  );
}

/**
 * The confirmation that makes a pre-filled link harmless.
 *
 * Reached only after the IdP round trip, and carrying a secret minted during it,
 * so this form cannot be submitted by whoever asked for the device code. It names
 * the code so an operator can check it against their own terminal: a code they
 * do not recognize is somebody else's device asking for their access, and Deny is
 * the button for that.
 */
export function deviceApprovalPage(options: {
  slug: string;
  tenantName: string;
  userCode: string;
  operator: string;
  approvalToken: string;
}): ReactNode {
  return (
    <Page
      title="Renkei — approve a device"
      heading="Approve this command line?"
      subheading={`${options.tenantName} · signed in as ${options.operator}`}
    >
      <p>
        A command-line client is asking for operator access to <strong>{options.tenantName}</strong>{' '}
        as you. Approving gives it the same reach as this console — reading the audit log, listing
        users and sites, and revoking sessions — for one hour.
      </p>
      <p>
        It says its code is <code className="mono">{options.userCode}</code>. Check that against the
        code in your own terminal.
      </p>
      <p className="warn">
        If those do not match, or you did not start this, choose Deny. Somebody else’s device is
        asking to act as you.
      </p>
      <form method="post" action={`/auth/device/${options.slug}/approve`}>
        <input type="hidden" name="approval" value={options.approvalToken} />
        <button type="submit" name="decision" value="approve" className="primary">
          Approve
        </button>{' '}
        <button type="submit" name="decision" value="deny" className="danger">
          Deny
        </button>
      </form>
    </Page>
  );
}

/** How a device flow ended. Nothing actionable left on the page. */
export function deviceOutcomePage(options: { tenantName: string; approved: boolean }): ReactNode {
  return options.approved ? (
    <Page title="Renkei — approved" heading="Device approved">
      <p>
        Your command line has been signed in to <strong>{options.tenantName}</strong>. You can close
        this window and return to your terminal.
      </p>
      <p className="sub">
        The session lasts one hour. Sign out early by revoking it at your identity provider.
      </p>
    </Page>
  ) : (
    <Page title="Renkei — denied" heading="Device denied" tone="problem">
      <p>
        Nothing was authorized, and the request has been discarded. The command line waiting on it
        will stop with an error.
      </p>
      <p className="sub">
        If you did not start that sign-in, somebody else has your tenant’s console URL and tried to
        use it. Worth telling whoever runs Renkei for you.
      </p>
    </Page>
  );
}

/**
 * The answer for a slug that is not a live tenant here.
 *
 * The same answer for "no such tenant" and "suspended", because
 * `renkei_resolve_slug` folds them together — suspension should not be a way
 * to confirm that a tenant exists.
 */
export function noConsolePage(): ReactNode {
  return (
    <Page title="Renkei" heading="No console here" tone="problem">
      <p>
        There is no operator console at this address. Check the tenant name in the URL against the
        one you were given.
      </p>
    </Page>
  );
}

export { Section };
