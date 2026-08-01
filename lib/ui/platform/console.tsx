/**
 * The platform console's signed-in pages: tenants, and the delivery log.
 *
 * Two pages, and the shortness of that list is the design. What a platform
 * operator can see here is deliberately narrower than what `pnpm tenant list`
 * shows — no site counts, no audit rows — because the role table says this role
 * sees nothing inside a tenant, and a console that quietly showed more would make
 * that sentence false.
 */

import type { ReactNode } from 'react';
import { Csrf, Page, Section } from '../layout.js';
import { PlatformConsolePage, type PlatformConsoleContext } from './pages.js';
import type {
  NotificationRecord,
  OnboardingTokenSummary,
  PlatformTenant,
} from '../../gateway/platform-store.js';

/** `YYYY-MM-DD HH:MM UTC`, matching the other consoles. */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

export interface TenantsView {
  context: PlatformConsoleContext;
  tenants: PlatformTenant[];
  /** False when no notifier can deliver, so the form asks for no recipient. */
  canDeliver: boolean;
}

export function tenantsPage(view: TenantsView): ReactNode {
  const { context } = view;

  return (
    <PlatformConsolePage context={context} heading="Tenants">
      <Section title="Create a tenant">
        <form method="post" action="/platform/tenants" className="row">
          <Csrf token={context.csrfToken} />
          <input
            name="slug"
            maxLength={63}
            required
            placeholder="acme"
            aria-label="Tenant slug"
            pattern="[a-z0-9][a-z0-9-]{1,62}"
          />
          <input name="name" maxLength={120} required placeholder="Acme Health" aria-label="Name" />
          <button type="submit" className="primary">
            Create
          </button>
        </form>
        <p className="muted" style={{ margin: '.35rem 0 0' }}>
          The slug appears in the operator’s console URL and cannot be changed afterwards.
        </p>
      </Section>

      {view.tenants.length === 0 ? (
        <p>
          No tenants yet. Creating one and issuing its operator an onboarding link is how a Jira
          site gets registered here.
        </p>
      ) : (
        view.tenants.map((tenant) => (
          <Section key={tenant.id} title={tenant.name}>
            <p className="muted">
              <span className="mono">{tenant.slug}</span> · {tenant.status} ·{' '}
              {tenant.hasOidc ? 'operator sign-in configured' : 'no identity provider yet'} ·
              created {stamp(tenant.createdAt)}
            </p>

            {tenant.hasOidc ? null : (
              <p className="warn">
                Its operators cannot sign in, so nobody can register a Jira site for it. Issue an
                onboarding link.
              </p>
            )}

            <form method="post" action="/platform/tenants/onboarding" className="row">
              <Csrf token={context.csrfToken} />
              <input type="hidden" name="slug" value={tenant.slug} />
              {view.canDeliver ? (
                <input
                  name="recipient"
                  type="text"
                  maxLength={200}
                  required
                  placeholder="who it goes to"
                  aria-label="Recipient"
                />
              ) : null}
              <label className="nowrap">
                <input type="checkbox" name="allowReplace" value="true" /> allow replacing an
                existing provider
              </label>
              <button type="submit">Issue onboarding link</button>
            </form>

            {tenant.hasOidc ? (
              <p className="muted" style={{ margin: '.35rem 0 0' }}>
                This tenant already has a provider, so a link only works if you tick the box — which
                repoints its operator authentication and signs its operators out.
              </p>
            ) : null}

            <form method="post" action="/platform/tenants/status" className="row">
              <Csrf token={context.csrfToken} />
              <input type="hidden" name="slug" value={tenant.slug} />
              <input
                type="hidden"
                name="status"
                value={tenant.status === 'active' ? 'suspended' : 'active'}
              />
              <button type="submit" className={tenant.status === 'active' ? 'danger' : undefined}>
                {tenant.status === 'active' ? 'Suspend' : 'Resume'}
              </button>
            </form>
          </Section>
        ))
      )}

      <p className="muted">
        Suspending a tenant stops its MCP endpoints resolving <em>and</em> closes its console, so it
        is not a partial measure. Nothing is deleted; resuming restores it.
      </p>
    </PlatformConsolePage>
  );
}

export interface OnboardingIssuedView {
  context: PlatformConsoleContext;
  tenantName: string;
  tenantSlug: string;
  /** Rendered once, here. Nothing can recover it afterwards. */
  link: string;
  expiresAt: string;
  allowReplace: boolean;
  /** How delivery went. Null when no notifier was asked. */
  delivery: { delivered: boolean; recipient: string; reason?: string } | null;
}

/**
 * The link, shown once.
 *
 * Outside the tab chrome and rendered directly rather than redirected to, for the
 * same reason the device-approval page is: this is the only moment the secret
 * exists in a form anybody can copy, and a redirect would put it in a query string
 * or lose it entirely.
 */
export function onboardingIssuedPage(view: OnboardingIssuedView): ReactNode {
  return (
    <Page
      title="Renkei — onboarding link"
      heading={`Onboarding link for ${view.tenantName}`}
      width="52rem"
    >
      <p>
        Give this to whoever will operate <span className="mono">{view.tenantSlug}</span>. It works
        once, and expires {stamp(view.expiresAt)}.
      </p>

      <p className="mono" style={{ wordBreak: 'break-all' }}>
        {view.link}
      </p>

      {view.allowReplace ? (
        <p className="warn">
          This link may replace an existing identity provider. Redeeming it repoints who can operate
          this tenant and signs out everyone currently signed in to its console.
        </p>
      ) : null}

      {view.delivery === null ? (
        <p className="muted">
          Nothing was sent — copy the link yourself. Configure a delivery channel to have it emailed
          or texted.
        </p>
      ) : view.delivery.delivered ? (
        <p className="notice">Recorded for delivery to {view.delivery.recipient}.</p>
      ) : (
        <p className="warn">
          The link was issued, but delivery to {view.delivery.recipient} failed
          {view.delivery.reason === undefined ? '' : `: ${view.delivery.reason}`}. Copy it from
          above — it is valid either way.
        </p>
      )}

      <p className="muted">
        This page is the only place it is shown. If it is lost, revoke it and issue another.
      </p>

      <p>
        <a className="btn" href="/platform/tenants">
          Back to tenants
        </a>
      </p>
    </Page>
  );
}

export interface NotificationsView {
  context: PlatformConsoleContext;
  notifications: NotificationRecord[];
  /** Live links per tenant slug, so a leaked one can be found and revoked. */
  outstanding: { tenantSlug: string; tokens: OnboardingTokenSummary[] }[];
}

export function notificationsPage(view: NotificationsView): ReactNode {
  const { context } = view;

  return (
    <PlatformConsolePage context={context} heading="Notifications">
      <Section title="Outstanding onboarding links">
        {view.outstanding.length === 0 ? (
          <p className="muted">Nothing outstanding. Every link issued has been used or expired.</p>
        ) : (
          view.outstanding.map((group) =>
            group.tokens.map((token) => (
              <p key={token.id} className="row">
                <span>
                  <span className="mono">{group.tenantSlug}</span> · issued {stamp(token.issuedAt)}{' '}
                  · expires {stamp(token.expiresAt)}
                  {token.allowReplace ? ' · may replace an existing provider' : ''}
                  {token.attempts > 0 ? ` · ${token.attempts} failed attempts` : ''}
                </span>
                <form method="post" action="/platform/tenants/onboarding/revoke">
                  <Csrf token={context.csrfToken} />
                  <input type="hidden" name="token" value={token.id} />
                  <button type="submit" className="danger">
                    Revoke
                  </button>
                </form>
              </p>
            )),
          )
        )}
      </Section>

      <Section title="Delivery log">
        {view.notifications.length === 0 ? (
          <p className="muted">Nothing has been sent.</p>
        ) : (
          view.notifications.map((record) => (
            <p key={record.id} className={record.acknowledgedAt === null ? undefined : 'spent'}>
              <strong>{record.subject}</strong>
              <br />
              <span className="muted">
                {record.channel} · {record.recipient} · {stamp(record.createdAt)} ·{' '}
                {record.deliveredAt === null
                  ? `not delivered${record.failureReason === null ? '' : ` (${record.failureReason})`}`
                  : 'delivered'}
              </span>
              <br />
              <span className="mono" style={{ wordBreak: 'break-all' }}>
                {record.body}
              </span>
              {record.acknowledgedAt === null ? (
                <>
                  <br />
                  <form method="post" action="/platform/notifications/ack">
                    <Csrf token={context.csrfToken} />
                    <input type="hidden" name="notification" value={record.id} />
                    <button type="submit">Dismiss</button>
                  </form>
                </>
              ) : null}
            </p>
          ))
        )}
      </Section>

      <p className="muted">
        A message body can contain a live onboarding link, which is why this page is behind the
        console and why the rows are deleted once their link is dead.
      </p>
    </PlatformConsolePage>
  );
}
