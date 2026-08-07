/**
 * `/onboard/<token>` — where a tenant operator configures their own identity
 * provider, and the only page in Renkei a signed-in nobody can reach.
 *
 * There is no session here and no cookie. The unguessable single-use token in the
 * URL is the whole authorization, which is the same shape the device-approval page
 * uses: it carries the token in a hidden field instead of a CSRF token, because
 * possession of the token is the thing being demonstrated and a second secret would
 * protect nothing that the first does not.
 */

import type { ReactNode } from 'react';
import { Page, Section } from '../layout.js';

export interface OnboardingFormView {
  /** Echoed into the form. The page's own authorization. */
  token: string;
  tenantName: string;
  tenantSlug: string;
  /** The two URIs the tenant must register with their provider. */
  consoleCallback: string;
  deviceCallback: string;
  /** True when this link may repoint an existing provider. */
  replacing: boolean;
  /** From a failed attempt: what went wrong, and what to put back in the fields. */
  error: string | null;
  values: {
    issuer: string;
    clientId: string;
    roleClaim: string;
    requiredRole: string;
  };
}

export function onboardingFormPage(view: OnboardingFormView): ReactNode {
  return (
    <Page
      title="Renkei — set up operator sign-in"
      heading={`Set up operator sign-in for ${view.tenantName}`}
      width="46rem"
    >
      {view.error === null ? null : <p className="warn">{view.error}</p>}

      {view.replacing ? (
        <p className="warn">
          This tenant already has an identity provider. Completing this form replaces it, and
          everyone currently signed in to its console is signed out.
        </p>
      ) : null}

      <p>
        Renkei does not hold operator passwords. Point it at your organization's OpenID Connect
        provider, and membership of a role there decides who may operate{' '}
        <span className="mono">{view.tenantSlug}</span> — so access is granted and removed in your
        own directory.
      </p>

      <Section title="First, in your identity provider">
        <p>
          Create an application that can use the authorization code flow with PKCE, and register
          both of these as redirect URIs:
        </p>
        <p className="mono" style={{ wordBreak: 'break-all' }}>
          {view.consoleCallback}
          <br />
          {view.deviceCallback}
        </p>
        <p className="muted">
          Both are needed. The first ends in a browser session, the second in a command-line
          approval, and keeping them apart is what stops a sign-in that began on one finishing on
          the other.
        </p>
      </Section>

      <Section title="Then, its details">
        <form method="post" action="/onboard">
          {/* The link itself is the authorization; see the file comment. */}
          <input type="hidden" name="token" value={view.token} />

          <fieldset>
            <label htmlFor="issuer">Issuer</label>
            <input
              id="issuer"
              name="issuer"
              type="url"
              required
              defaultValue={view.values.issuer}
              placeholder="https://example.okta.com/oauth2/default"
              style={{ width: '100%' }}
            />
            <p className="muted">
              Copy it exactly as your provider states it,{' '}
              <strong>including a trailing slash</strong> if it has one — Auth0 and Entra both do.
              It is compared character for character against the provider's own discovery document,
              so a slash added or removed here is a sign-in that can never succeed. Renkei checks
              this before saving.
            </p>

            <label htmlFor="clientId">Client ID</label>
            <input
              id="clientId"
              name="clientId"
              required
              defaultValue={view.values.clientId}
              style={{ width: '100%' }}
            />

            <label htmlFor="clientSecret">Client secret</label>
            <input
              id="clientSecret"
              name="clientSecret"
              type="password"
              required
              style={{ width: '100%' }}
            />
            <p className="muted">
              Stored encrypted. It is never shown again, and the platform operator cannot read it
              back.
            </p>

            <label htmlFor="roleClaim">Role claim</label>
            <input
              id="roleClaim"
              name="roleClaim"
              defaultValue={view.values.roleClaim}
              placeholder="roles"
              style={{ width: '100%' }}
            />
            <p className="muted">
              Which claim in the ID token carries role membership. Auth0 requires a namespaced name
              such as <span className="mono">https://your.example/roles</span>.
            </p>

            <label htmlFor="requiredRole">Operator role</label>
            <input
              id="requiredRole"
              name="requiredRole"
              defaultValue={view.values.requiredRole}
              placeholder="renkei-operators"
              style={{ width: '100%' }}
            />
            <p className="muted">
              Leave this empty only if the application itself is restricted to the right people —
              empty means every subject your provider authenticates can operate this tenant.
            </p>

            <label className="nowrap">
              <input type="checkbox" name="acceptOpenRole" value="true" /> I understand what an
              empty operator role means
            </label>
          </fieldset>

          <p>
            <button type="submit" className="primary">
              Save and check
            </button>
          </p>
        </form>
      </Section>
    </Page>
  );
}

export function onboardingDonePage(options: { tenantName: string; consoleUrl: string }): ReactNode {
  return (
    <Page title="Renkei — set up" heading={`${options.tenantName} is ready`} width="46rem">
      <p>
        Operator sign-in is configured and the provider answered when Renkei checked it. Sign in to
        register a Jira site.
      </p>
      <p>
        <a className="btn primary" href={options.consoleUrl}>
          Open the console
        </a>
      </p>
      <p className="muted">
        This link has now been used and will not work again. Registering a Jira site is the next
        step, and it asks you to prove you administer the site through Atlassian.
      </p>
    </Page>
  );
}

/**
 * One page for every dead-token reason.
 *
 * Expired, already used, revoked, out of attempts, and never existed all render the
 * same words: telling a caller which one it was turns this into an oracle for
 * probing links, and there is nothing the legitimate holder of a dead link can do
 * differently in any of the five cases.
 */
export function onboardingRefusedPage(): ReactNode {
  return (
    <Page title="Renkei" heading="That link cannot be used" tone="problem" width="46rem">
      <p>
        This setup link has expired, has already been used, or was withdrawn. Ask whoever sent it
        for a new one.
      </p>
    </Page>
  );
}
