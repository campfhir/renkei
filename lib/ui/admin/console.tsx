/**
 * The five console pages: sites, onboard-site, people, the audit log, and
 * settings.
 *
 * All of them take plain rows. None of them takes a store, so no page can decide
 * to read something the route did not already decide it was allowed to see -
 * which is the same reason `AdminStore` is a separate interface from
 * `GatewayStore`, one layer down.
 */

import type { ReactNode } from 'react';
import { Csrf, Section } from '../layout.js';
import { ConsolePage, type ConsoleContext } from './pages.js';
import type {
  AdminAuditRow,
  AdminSession,
  AdminSite,
  AdminUser,
  TenantKeyMetadata,
} from '../../gateway/admin-store.js';
import { LogsPanel } from './logs.js';

/** UTC and deterministic: a console read beside a Jira audit trail should not raise "whose clock". */
function stamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function base(context: ConsoleContext): string {
  return `/admin/${context.tenant.slug}`;
}

/**
 * Progressive enhancement, and the reason the URL sits in an input rather than a
 * `<code>` block: without the script the value is still selectable and copyable by
 * hand. One script for every connector URL on the page, since the sites table can
 * have more than one row.
 */
const COPY_SCRIPT = `
  document.querySelectorAll('.copy-btn').forEach(function (button) {
    button.addEventListener('click', function () {
      var field = button.previousElementSibling;
      field.select();
      navigator.clipboard.writeText(field.value).then(function () {
        var original = button.textContent;
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = original; }, 2000);
      }, function () {});
    });
  });
`;

// -------------------------------------------------------------------- sites

export interface SitesView {
  context: ConsoleContext;
  sites: AdminSite[];
  connectorBase: string;
}

export function sitesPage(view: SitesView): ReactNode {
  const { context } = view;

  return (
    <ConsolePage context={context} heading="Sites">
      <Section title="Registered sites">
        {view.sites.length === 0 ? (
          <p>
            No sites are registered yet. Registering one is what creates an endpoint for your users
            to connect to.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Connector URL</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.sites.map((site) => {
                const primary = site.jiraUrl ?? site.siteUrl ?? site.cloudId;
                const showCloudId = primary !== site.cloudId;
                return (
                  <tr key={site.id} className={site.enabled ? undefined : 'spent'}>
                    <td>
                      <span className="mono">{primary}</span>
                      {showCloudId || !site.enabled ? (
                        <p className="muted" style={{ margin: '.2rem 0 0' }}>
                          {showCloudId ? <span className="mono">{site.cloudId}</span> : null}
                          {site.enabled ? null : showCloudId ? ' - disabled' : 'disabled'}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <div
                        style={{
                          display: 'flex',
                          gap: '.5rem',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        <input
                          readOnly
                          className="mono"
                          value={`${view.connectorBase}/mcp/${site.id}`}
                          aria-label="Connector URL"
                          style={{ flex: '1 1 16rem' }}
                        />
                        <button type="button" className="copy-btn">
                          Copy
                        </button>
                      </div>
                    </td>
                    <td>
                      <form method="post" action={`${base(context)}/sites/enabled`}>
                        <Csrf token={context.csrfToken} />
                        <input type="hidden" name="site" value={site.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={site.enabled ? 'false' : 'true'}
                        />
                        <button type="submit" className={site.enabled ? 'danger' : undefined}>
                          {site.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted">
          Disabling a site makes its endpoint stop resolving, so every token issued for it is
          refused the same way an unknown endpoint is. Sessions are left alone, so enabling it again
          restores them.
        </p>
      </Section>

      <Section title="Connect a site">
        <p>
          Entering your Jira URL mints an endpoint for it; the cloud ID is resolved automatically.
          This does not grant access by itself - anyone who authorizes against it acts with their
          own Jira permissions.
        </p>
        <form method="post" action={`${base(context)}/sites/claim`} className="row">
          <Csrf token={context.csrfToken} />
          <input
            name="jiraUrl"
            required
            maxLength={200}
            placeholder="https://mycompany.atlassian.net"
            aria-label="Jira URL"
          />
          <button type="submit">Connect</button>
        </form>
      </Section>

      <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
    </ConsolePage>
  );
}

/**
 * The wizard's last step: add the tenant's first Jira instance.
 *
 * Reached already signed in - the self-service wizard mints an operator
 * session before redirecting here (see mintOperatorSession in
 * ../../gateway/admin-routes.ts) - so this uses the normal console chrome
 * rather than a bare page. Posts to the same `/sites/claim` endpoint the
 * regular Sites page uses to add further sites later.
 */
export function onboardSitePage(options: {
  context: ConsoleContext;
  error?: string | null;
}): ReactNode {
  const { context } = options;

  return (
    <ConsolePage context={context} heading="Add your Jira instance">
      <Section title="Connect your Jira site">
        {options.error ? <p className="warn">{options.error}</p> : null}
        <p>
          Enter your Jira domain and we'll set up an MCP endpoint for your site. The cloud ID is
          resolved automatically. Anyone who authorizes against it acts with their own Jira
          permissions - connecting your site does not grant access by itself.
        </p>
        <form method="post" action={`${base(context)}/sites/claim`}>
          <Csrf token={context.csrfToken} />
          <p>
            <label htmlFor="jiraUrl">Jira URL</label>
            <br />
            <input
              id="jiraUrl"
              name="jiraUrl"
              required
              maxLength={200}
              placeholder="https://mycompany.atlassian.net"
              style={{ width: '100%' }}
            />
            <br />
            <span className="muted">
              Enter your Jira domain URL (e.g., mycompany.atlassian.net or a custom domain).
            </span>
          </p>
          <button type="submit" className="primary">
            Connect
          </button>
        </form>
        <p className="sub" style={{ marginTop: '1.5rem' }}>
          Or <a href={`${base(context)}/sites`}>skip this for now</a> and add it later from Sites.
        </p>
      </Section>
    </ConsolePage>
  );
}

// ------------------------------------------------------------------- people

export interface PeopleView {
  context: ConsoleContext;
  users: AdminUser[];
  sessions: AdminSession[];
}

export function peoplePage(view: PeopleView): ReactNode {
  const { context } = view;

  return (
    <ConsolePage context={context} heading="People & sessions">
      <Section title="People">
        <p>
          Membership is derived from Atlassian site access rather than from an invitation: somebody
          appears here when they consent at one of this tenant's endpoints, and only if they can
          reach that Jira site themselves.
        </p>
        {view.users.length === 0 ? (
          <p>Nobody has connected yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th className="nowrap">First seen</th>
                <th className="nowrap">Sessions</th>
                <th>Credential</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.users.map((user) => (
                <tr key={user.accountId}>
                  <td>
                    {user.displayName}
                    <p className="muted" style={{ margin: '.2rem 0 0' }}>
                      <span className="mono">{user.accountId}</span>
                    </p>
                  </td>
                  <td className="nowrap">{stamp(user.firstSeenAt)}</td>
                  <td className="nowrap">{user.liveSessions}</td>
                  <td className="nowrap">{user.hasGrant ? 'on file' : 'none'}</td>
                  <td>
                    <form method="post" action={`${base(context)}/people/revoke`}>
                      <Csrf token={context.csrfToken} />
                      <input type="hidden" name="account" value={user.accountId} />
                      <button type="submit" className="danger" name="scope" value="sessions">
                        Revoke sessions
                      </button>{' '}
                      <button type="submit" className="danger" name="scope" value="credential">
                        Delete credential
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          You can end someone's access and you cannot use it. There is no path from this console to
          a person's Atlassian token, deliberately - it is what keeps the audit log meaning that
          every row in it is that person acting as themselves.
        </p>
      </Section>

      <Section title="Sessions">
        {view.sessions.length === 0 ? (
          <p>No sessions have been opened.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Client</th>
                <th>Site</th>
                <th className="nowrap">Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.sessions.map((session) => (
                <tr key={session.id} className={session.revokedAt === null ? undefined : 'spent'}>
                  <td>{session.displayName}</td>
                  <td>{session.clientName}</td>
                  <td>{session.siteJiraUrl ?? session.siteCloudId}</td>
                  <td className="nowrap">{stamp(session.lastSeenAt)}</td>
                  <td>
                    {session.revokedAt === null ? (
                      <form method="post" action={`${base(context)}/sessions/revoke`}>
                        <Csrf token={context.csrfToken} />
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
        )}
      </Section>
    </ConsolePage>
  );
}

// ---------------------------------------------------------------- audit log

export interface AuditView {
  context: ConsoleContext;
  rows: AdminAuditRow[];
  /** The `before` value for the next page, or null at the end. */
  nextBefore: string | null;
}

export function auditPage(view: AuditView): ReactNode {
  const { context } = view;

  return (
    <ConsolePage context={context} heading="Audit log">
      <Section title="Tool calls">
        <p>
          Who called what, against which work items. Never any issue content: no descriptions, no
          comment bodies, no search results. That is a property of what is written, not of what this
          page chooses to show.
        </p>
        {view.rows.length === 0 ? (
          <p>Nothing has been recorded yet.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th className="nowrap">When</th>
                  <th>Person</th>
                  <th>Tool</th>
                  <th>Work items</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.id} className={row.outcome === 'success' ? undefined : 'spent'}>
                    <td className="nowrap">{stamp(row.occurredAt)}</td>
                    <td>{row.displayName ?? row.accountId}</td>
                    <td className="mono">{row.tool}</td>
                    <td className="mono">{row.issueKeys.join(' ')}</td>
                    <td>{row.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {view.nextBefore === null ? null : (
              <p style={{ margin: '1rem 0 0' }}>
                <a
                  className="btn"
                  href={`${base(context)}/audit?before=${encodeURIComponent(view.nextBefore)}`}
                >
                  Older
                </a>
              </p>
            )}
          </>
        )}
      </Section>
    </ConsolePage>
  );
}

// ----------------------------------------------------------------- settings

export interface SettingsView {
  context: ConsoleContext;
  key: TenantKeyMetadata;
}

export function settingsPage(view: SettingsView): ReactNode {
  const { context } = view;

  return (
    <ConsolePage context={context} heading="Settings">
      <Section title="Encryption key">
        <p>
          Your users' Atlassian credentials are encrypted before they reach the database. By default
          that uses this deployment's key. Supplying your own limits the blast radius of a breach
          elsewhere on the deployment to everyone but you.
        </p>
        <p className="muted">
          Currently:{' '}
          {view.key.source === 'deployment'
            ? 'the deployment key.'
            : view.key.source === 'literal'
              ? `your own key, set ${stamp(view.key.updatedAt ?? '')}.`
              : `an external KMS key (${view.key.kmsProvider ?? 'unknown'}).`}
        </p>
        <p>
          <strong>Read this before changing it.</strong> Credentials already stored stay readable -
          they are re-encrypted under the new key the next time each one is refreshed, which happens
          within the hour for anyone actively using a connector. A key you supply is stored wrapped
          under the deployment key, so it limits blast radius rather than excluding whoever runs
          this deployment; only a KMS key you hold does that, and that is not built yet.
        </p>
        <form method="post" action={`${base(context)}/settings/key`}>
          <Csrf token={context.csrfToken} />
          <fieldset>
            <label htmlFor="key">32 bytes, base64 (openssl rand -base64 32)</label>
            <input id="key" name="key" required className="mono" style={{ width: '100%' }} />
          </fieldset>
          <button type="submit">Use my own key</button>
        </form>
        {view.key.source === 'deployment' ? null : (
          <form
            method="post"
            action={`${base(context)}/settings/key/clear`}
            style={{ margin: '1rem 0 0' }}
          >
            <Csrf token={context.csrfToken} />
            <button type="submit" className="danger">
              Go back to the deployment key
            </button>
          </form>
        )}
      </Section>
    </ConsolePage>
  );
}

// ----------------------------------------------------------------- logs

export interface LogsView {
  context: ConsoleContext;
}

export function logsPage(view: LogsView): ReactNode {
  const { context } = view;

  return (
    <ConsolePage context={context} heading="Error logs">
      <Section title="Application logs">
        <p>
          System logs for API errors, authentication failures, and rate limit events. Use the search
          and filters below to find specific issues.
        </p>
        <LogsPanel context={context} />
      </Section>
    </ConsolePage>
  );
}
