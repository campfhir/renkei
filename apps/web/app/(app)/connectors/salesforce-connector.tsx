import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { SALESFORCE_SCOPE_GROUPS, SALESFORCE_SCOPE_OPTIONS } from '@/lib/salesforce-scopes';

/**
 * A person's connection to ONE Salesforce connector — one org, production
 * or a sandbox — in the organization's own Salesforce, with the person's
 * own access there. The page renders one card per connector, each
 * connected separately; the GitHub/Entra Developer card shape otherwise:
 * connection state server-rendered, a connect link that narrows Renkei's
 * capabilities within this connector's ceiling, confirm-gated disconnect.
 */
export default function SalesforceConnector({
  connectorKey,
  name,
  sandbox,
  orgHost,
  connected,
  displayName,
  username,
  ceiling,
  priorScopes,
}: {
  connectorKey: string;
  /** The connector's name (Production, UAT…). */
  name: string;
  sandbox: boolean;
  /** The org's My Domain host, so a person signs in to the right org. */
  orgHost: string;
  connected: boolean;
  displayName: string | null;
  /** The Salesforce username of the connection, shown beside the name. */
  username: string | null;
  /** This connector's allowed capabilities — the most a person can grant. */
  ceiling: string[];
  /** Capabilities on the person's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const base = `/api/salesforce/${encodeURIComponent(connectorKey)}`;
  const label = `Salesforce · ${name}`;

  return (
    <ConnectorShell anchor="card-salesforce">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="salesforce" label="Salesforce" size={20} />
          {label}
          {sandbox && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
              Sandbox
            </span>
          )}
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>
            {username && username !== displayName ? <> ({username})</> : null} to{' '}
            <span className="break-words font-mono text-xs">{orgHost}</span>. Records, related
            records and reports in this org are read and changed on this connection, with the access
            you have there.
          </>
        ) : (
          <>
            Find and update records — standard objects and your organization&apos;s own custom ones
            — log calls and tasks, and run reports and dashboards in this
            {sandbox ? ' sandbox' : ' org'}, without opening Salesforce. Salesforce checks your own
            access on every call. You will sign in at{' '}
            <span className="break-words font-mono text-xs">{orgHost}</span>.
          </>
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={SALESFORCE_SCOPE_GROUPS}
          options={SALESFORCE_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={`${base}/authorize`}
          connectLabel={`Connect ${label}`}
          scopesAnchor="salesforce-scopes"
          connectAnchor="salesforce-connect"
        />
      )}

      {connected && (
        <CoachTarget name="salesforce-scopes">
          <AuthorizedPermissions
            options={SALESFORCE_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel={label}
          >
            <ReconnectScopePanel
              groups={SALESFORCE_SCOPE_GROUPS}
              options={SALESFORCE_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={`${base}/authorize`}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`${base}/grant`}
          confirmText={`Disconnect ${label}? Its tools stop working in this org until you reconnect, and the connection is revoked in Salesforce too. Your other Salesforce connections are not affected.`}
          buttonLabel={`Disconnect ${label}`}
        />
      )}
    </ConnectorShell>
  );
}

/** Connections to orgs an admin has since removed: shown so a person can revoke them. */
export function SalesforceOrphanedConnections({
  connections,
}: {
  connections: { accountId: string; displayName: string; instanceUrl: string }[];
}) {
  return (
    <ConnectorShell>
      <ConnectorHeading>
        <ConnectorIcon capabilityKey="salesforce" label="Salesforce" size={20} />
        Salesforce connections to removed orgs
      </ConnectorHeading>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Your organization no longer has a Salesforce connector for{' '}
        {connections
          .map((c) => new URL(c.instanceUrl || 'https://unknown.invalid').hostname)
          .join(', ')}
        , so these connections do nothing. Revoke them to remove them from Salesforce too.
      </p>
      <DisconnectControl
        endpoint="/api/salesforce/-/grant"
        confirmText="Revoke these Salesforce connections? They are removed from Salesforce too."
        buttonLabel="Revoke removed-org connections"
      />
    </ConnectorShell>
  );
}
