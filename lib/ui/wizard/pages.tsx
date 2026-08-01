/**
 * `/` and `/create-organization` — self-service onboarding.
 *
 * No session and no cookie on any page here, the same shape
 * `../onboarding/pages.tsx` uses for `/onboard/<token>`: there is nobody
 * signed in yet, so there is nothing a CSRF token would protect. The wizard
 * ends by hand-off to the console's own session machinery — see
 * `mintOperatorSession` in ../../gateway/admin-routes.ts — once a real login
 * has happened.
 */

import type { ReactNode } from 'react';
import { Page, Section } from '../layout.js';

export function homeRealmPage(options: { notice?: string | null }): ReactNode {
  return (
    <Page title="Renkei" heading="Sign in to Renkei" width="30rem">
      {options.notice ? <p className="warn">{options.notice}</p> : null}
      <p>Enter your work email, and we’ll find your organization.</p>
      <form method="post" action="/">
        <p>
          <label htmlFor="email">Work email</label>
          <br />
          <input
            id="email"
            name="email"
            type="email"
            required
            autoFocus
            placeholder="you@example.com"
            style={{ width: '100%' }}
          />
        </p>
        <button type="submit" className="primary">
          Continue
        </button>
      </form>
      <p className="sub" style={{ marginTop: '2rem' }}>
        First time here? <a href="/create-organization">Create your organization</a> instead.
      </p>
    </Page>
  );
}

export function suspendedPage(options: { orgName: string }): ReactNode {
  return (
    <Page title="Renkei" heading="Access suspended" tone="problem" width="30rem">
      <p>
        <strong>{options.orgName}</strong>’s access to Renkei is currently suspended. Whoever
        administers your organization’s account can tell you more.
      </p>
      <p className="sub">
        <a href="/">Back</a>
      </p>
    </Page>
  );
}

export interface OrganizationFormView {
  orgName: string;
  domain: string;
  error: string | null;
}

export function organizationFormPage(view: OrganizationFormView): ReactNode {
  return (
    <Page
      title="Renkei — create your organization"
      heading="Create your organization"
      width="34rem"
    >
      {view.error ? <p className="warn">{view.error}</p> : null}
      <p>
        This creates one Renkei tenant for your organization, with its own sign-in and its own Jira
        connection.
      </p>
      <form method="post" action="/create-organization">
        <p>
          <label htmlFor="orgName">Organization name</label>
          <br />
          <input
            id="orgName"
            name="orgName"
            required
            maxLength={200}
            defaultValue={view.orgName}
            placeholder="Acme Health"
            style={{ width: '100%' }}
          />
        </p>
        <p>
          <label htmlFor="domain">Email domain</label>
          <br />
          <input
            id="domain"
            name="domain"
            required
            defaultValue={view.domain}
            placeholder="acme.com"
            style={{ width: '100%' }}
          />
          <br />
          <span className="muted">
            Everyone who signs in with this email domain will land in your organization. You’ll
            prove you control it by signing in through your own identity provider in the next step.
          </span>
        </p>
        <button type="submit" className="primary">
          Continue
        </button>
      </form>
      <p className="sub" style={{ marginTop: '2rem' }}>
        Already have an organization here? <a href="/">Sign in</a> instead.
      </p>
    </Page>
  );
}

export interface ConfigureIdpView {
  orgName: string;
  domain: string;
  slug: string;
  /** The single fixed redirect URI every signup registers with its IdP. */
  callbackUri: string;
  error: string | null;
  values: {
    issuer: string;
    clientId: string;
    roleClaim: string;
    requiredRole: string;
  };
}

export function configureIdpPage(view: ConfigureIdpView): ReactNode {
  return (
    <Page
      title="Renkei — configure your identity provider"
      heading={`Configure sign-in for ${view.orgName}`}
      width="46rem"
    >
      {view.error ? <p className="warn">{view.error}</p> : null}

      <p>
        Renkei does not hold operator passwords. Point it at your organization’s OpenID Connect
        provider, and membership of a role there decides who may operate this tenant. Completing
        this step also proves you control <span className="mono">{view.domain}</span> — you’ll be
        sent to sign in through the provider below, and that domain has to appear in the account
        that comes back.
      </p>

      <Section title="First, in your identity provider">
        <p>
          Create an application that can use the authorization code flow with PKCE, and register
          this exact redirect URI:
        </p>
        <p className="mono" style={{ wordBreak: 'break-all' }}>
          {view.callbackUri}
        </p>
      </Section>

      <Section title="Then, its details">
        <form method="post" action="/create-organization/idp">
          <input type="hidden" name="orgName" value={view.orgName} />
          <input type="hidden" name="domain" value={view.domain} />
          <input type="hidden" name="slug" value={view.slug} />

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
              Copy it exactly as your provider states it, including a trailing slash if it has one —
              it is compared character for character against the provider’s own discovery document.
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
            <p className="muted">Stored encrypted, and never shown again.</p>

            <label htmlFor="roleClaim">Role claim</label>
            <input
              id="roleClaim"
              name="roleClaim"
              defaultValue={view.values.roleClaim}
              placeholder="roles"
              style={{ width: '100%' }}
            />
            <p className="muted">Which claim in the ID token carries role membership.</p>

            <label htmlFor="requiredRole">Operator role</label>
            <input
              id="requiredRole"
              name="requiredRole"
              defaultValue={view.values.requiredRole}
              placeholder="renkei-operators"
              style={{ width: '100%' }}
            />
            <p className="muted">
              Leave this empty only if the application itself is restricted to the right people.
            </p>

            <label className="nowrap">
              <input type="checkbox" name="acceptOpenRole" value="true" /> I understand what an
              empty operator role means
            </label>
          </fieldset>

          <p>
            <button type="submit" className="primary">
              Continue to sign-in
            </button>
          </p>
        </form>
      </Section>
    </Page>
  );
}

export function domainMismatchPage(options: {
  domain: string;
  signedInEmail: string | null;
}): ReactNode {
  return (
    <Page
      title="Renkei"
      heading="That account isn’t on the right domain"
      tone="problem"
      width="34rem"
    >
      <p>
        {options.signedInEmail ? (
          <>
            You signed in as <span className="mono">{options.signedInEmail}</span>, but you’re
            claiming <span className="mono">{options.domain}</span>.
          </>
        ) : (
          <>
            Your identity provider didn’t confirm an email on{' '}
            <span className="mono">{options.domain}</span>.
          </>
        )}{' '}
        Sign in with an account on that domain to prove you control it.
      </p>
      <p className="sub">
        <a href="/create-organization">Start over</a>
      </p>
    </Page>
  );
}

export function domainConflictPage(options: { domain: string }): ReactNode {
  return (
    <Page title="Renkei" heading="That domain is already claimed" tone="problem" width="34rem">
      <p>
        <span className="mono">{options.domain}</span> was claimed by another organization while you
        were signing in. If that’s your organization, sign in instead.
      </p>
      <p className="sub">
        <a href="/">Sign in</a> · <a href="/create-organization">Start over</a>
      </p>
    </Page>
  );
}

export function slugTakenPage(options: { orgName: string }): ReactNode {
  return (
    <Page title="Renkei" heading="That name is taken" tone="problem" width="34rem">
      <p>
        An organization already exists with a name too similar to <strong>{options.orgName}</strong>
        . Pick a different name and start over — this step arrives after signing in, so you’ll need
        to enter your identity provider’s details again too.
      </p>
      <p className="sub">
        <a href="/create-organization">Start over</a>
      </p>
    </Page>
  );
}
