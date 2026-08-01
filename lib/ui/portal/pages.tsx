/**
 * The `/me` pages.
 *
 * Four things a user needs and would otherwise have to ask an operator for: which
 * connector URL is theirs, what to call it, which AI clients are connected as
 * them, and how to stop one.
 *
 * On the same chrome as the operator console rather than its own string
 * templates. Two ways to render HTML in one codebase is one too many, and the
 * reason to prefer this one is the same here as there: this page renders a
 * session's client name, which is whatever the client called itself at
 * registration, and with `ENABLE_DCR=true` that is anybody.
 */

import type { ReactNode } from 'react';
import { ACCENT, Csrf, Page, Section } from '../layout.js';
import type { SessionSummary } from '../../gateway/store.js';

export interface PortalView {
  displayName: string;
  /** From Atlassian. Null until a grant has reported it. */
  siteUrl: string | null;
  /** What this user calls the connection. */
  label: string | null;
  connectorUrl: string;
  csrfToken: string;
  sessions: SessionSummary[];
  /** The outcome of the POST that redirected here, if any. */
  notice: string | null;
}

/**
 * Deterministic and in UTC rather than localized.
 *
 * A session list is read next to a Jira audit trail and an incident timeline, and
 * "was that my local time or the server's" is a question this page should not
 * raise. It also keeps the rendering assertable in a test.
 */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Progressive enhancement, and the reason the URL sits in an input rather than a
 * `<code>` block: without the script the value is still selectable and copyable
 * by hand. No external anything.
 */
const COPY_SCRIPT = `
  document.getElementById('copy').addEventListener('click', function () {
    var field = document.getElementById('connector');
    field.select();
    navigator.clipboard.writeText(field.value).then(function () {
      var button = document.getElementById('copy');
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 2000);
    }, function () {});
  });
`;

function Sessions({ view }: { view: PortalView }): ReactNode {
  if (view.sessions.length === 0) {
    return (
      <p>
        Nothing is connected yet. Add the connector URL above to your AI client, and the session it
        opens will appear here.
      </p>
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Client</th>
          <th className="nowrap">Connected</th>
          <th className="nowrap">Last used</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {view.sessions.map((session) => (
          <tr key={session.id} className={session.revokedAt === null ? undefined : 'spent'}>
            <td>{session.clientName}</td>
            <td className="nowrap">{stamp(session.createdAt)}</td>
            <td className="nowrap">{stamp(session.lastSeenAt)}</td>
            <td>
              {session.revokedAt === null ? (
                <form method="post" action="/me/revoke">
                  <Csrf token={view.csrfToken} />
                  <input type="hidden" name="session" value={session.id} />
                  <button type="submit" className="danger">
                    Revoke
                  </button>
                </form>
              ) : (
                <span className="muted">revoked {stamp(session.revokedAt)}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function portalPage(view: PortalView): ReactNode {
  const site = view.siteUrl ?? 'your Jira site';

  return (
    <Page
      title="Renkei - your connection"
      heading={view.label ?? site}
      subheading={`Signed in as ${view.displayName} on ${site}.`}
      width="42rem"
    >
      {view.notice === null ? null : <p className="notice">{view.notice}</p>}

      <Section title="Connector URL">
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            id="connector"
            readOnly
            className="mono"
            value={view.connectorUrl}
            aria-label="Connector URL"
            style={{ flex: '1 1 22rem' }}
          />
          <button type="button" id="copy">
            Copy
          </button>
        </div>
        <p className="muted">
          Add this to your AI client as a custom connector. It will ask you to sign in to Atlassian,
          and from then on it acts as you, with your Jira permissions and nothing more. This URL is
          not a secret and not a credential. It names the site; access still comes from your own
          Atlassian sign-in.
        </p>
      </Section>

      <Section title="Your sessions">
        <Sessions view={view} />
      </Section>

      <Section title="Disconnect">
        <p>
          Revokes every session above and deletes the Atlassian credential Renkei holds for you on
          this site. Your Jira account is untouched, and connecting again re-authorizes from
          scratch.
        </p>
        <form method="post" action="/me/disconnect">
          <Csrf token={view.csrfToken} />
          <button type="submit" className="danger">
            Disconnect this site
          </button>
        </form>
      </Section>

      <form method="post" action="/me/sign-out" style={{ margin: '2.5rem 0 0' }}>
        <Csrf token={view.csrfToken} />
        <button type="submit">Sign out of this page</button>
      </form>

      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </Page>
  );
}

/**
 * The unauthenticated landing page.
 *
 * Deliberately says nothing about which sites or tenants this deployment serves:
 * the only thing it knows before sign-in is that Atlassian can identify the
 * visitor, and the site they pick over there is what settles the rest.
 */
export function portalSignInPage(reason: string | null): ReactNode {
  return (
    <Page title="Renkei - sign in" heading="Your Jira connection">
      {reason === null ? null : <p className="warn">{reason}</p>}
      <p>
        Sign in with Atlassian to get the connector URL for your Jira site, name it, and see which
        AI clients are connected as you.
      </p>
      <p>
        Atlassian will ask which site to use. Pick the one you want to connect - that choice is what
        tells Renkei who you are here.
      </p>
      <p>
        <a
          className="btn primary"
          href="/me/sign-in"
          style={{ background: ACCENT, borderColor: ACCENT, color: '#fff' }}
        >
          Sign in with Atlassian
        </a>
      </p>
    </Page>
  );
}
