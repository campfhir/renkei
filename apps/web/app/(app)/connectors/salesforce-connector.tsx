import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import Link from 'next/link';
import { SALESFORCE_CRM_KIND, type SalesforceKind } from '@/lib/salesforce-kinds';

/**
 * A person's connection to ONE Salesforce connector — one org, production
 * or a sandbox — in the organization's own Salesforce, with the person's
 * own access there. The page renders one card per connector, each
 * connected separately; the GitHub/Entra Developer card shape otherwise:
 * connection state server-rendered, a connect link that narrows Renkei's
 * capabilities within this connector's ceiling, confirm-gated disconnect.
 *
 * The same card serves the admin connector (`kind`), which also links the
 * person's change requests waiting in this org.
 */
export default function SalesforceConnector({
  kind = SALESFORCE_CRM_KIND,
  connectorKey,
  name,
  sandbox,
  orgHost,
  connected,
  displayName,
  username,
  ceiling,
  priorScopes,
  pendingChanges = 0,
  takesChanges = true,
}: {
  kind?: SalesforceKind;
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
  /** Admin connectors: the person's change requests waiting in this org. */
  pendingChanges?: number;
  /** Admin connectors: whether this org takes change requests (a production org may not). */
  takesChanges?: boolean;
}) {
  const admin = kind.key !== SALESFORCE_CRM_KIND.key;
  const base = `${kind.apiBase}/${encodeURIComponent(connectorKey)}`;
  const label = `${kind.label} · ${name}`;

  return (
    <ConnectorShell anchor={admin ? 'card-salesforce-admin' : 'card-salesforce'}>
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
            <span className="break-words font-mono text-xs">{orgHost}</span>.{' '}
            {admin
              ? takesChanges
                ? 'Changes to this org’s setup are proposed on this connection, validated by Salesforce, and applied only when you approve them here.'
                : 'This production org is read only here: build in a sandbox.'
              : 'Records, related records and reports in this org are read and changed on this connection, with the access you have there.'}
          </>
        ) : admin ? (
          <>
            Read how this {sandbox ? 'sandbox' : 'org'} is built — objects, fields, validation rules
            — and propose new fields and rules. Salesforce validates each proposal, and nothing
            changes until you apply it in Renkei, with the Setup permissions you hold. You will sign
            in at <span className="break-words font-mono text-xs">{orgHost}</span>.
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

      {admin && (
        <p className="mt-2 text-sm">
          <Link href="/salesforce-admin/changes" className="underline">
            {pendingChanges > 0
              ? `${pendingChanges} change request${pendingChanges === 1 ? '' : 's'} waiting for review`
              : 'Change requests'}
          </Link>
        </p>
      )}

      {!connected && (
        <ConnectScopePanel
          groups={kind.scopeGroups}
          options={kind.scopeOptions}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={`${base}/authorize`}
          connectLabel={`Connect ${label}`}
          scopesAnchor={admin ? 'salesforce-admin-scopes' : 'salesforce-scopes'}
          connectAnchor={admin ? 'salesforce-admin-connect' : 'salesforce-connect'}
        />
      )}

      {connected && (
        <CoachTarget name={admin ? 'salesforce-admin-scopes' : 'salesforce-scopes'}>
          <AuthorizedPermissions
            options={kind.scopeOptions}
            authorized={priorScopes}
            connectorLabel={label}
          >
            <ReconnectScopePanel
              groups={kind.scopeGroups}
              options={kind.scopeOptions}
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
          confirmText={`Disconnect ${label}? Its tools stop working in this org until you reconnect, and the connection is revoked in Salesforce too. Your other Salesforce connections are not affected.${admin ? ' Change requests waiting for this org cannot be applied until you reconnect.' : ''}`}
          buttonLabel={`Disconnect ${label}`}
        />
      )}
    </ConnectorShell>
  );
}

/** Connections to orgs an admin has since removed: shown so a person can revoke them. */
export function SalesforceOrphanedConnections({
  kind = SALESFORCE_CRM_KIND,
  connections,
}: {
  kind?: SalesforceKind;
  connections: { accountId: string; displayName: string; instanceUrl: string }[];
}) {
  return (
    <ConnectorShell>
      <ConnectorHeading>
        <ConnectorIcon capabilityKey="salesforce" label="Salesforce" size={20} />
        {kind.label} connections to removed orgs
      </ConnectorHeading>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Your organization no longer has a {kind.label} connector for{' '}
        {connections
          .map((c) => new URL(c.instanceUrl || 'https://unknown.invalid').hostname)
          .join(', ')}
        , so these connections do nothing. Revoke them to remove them from Salesforce too.
      </p>
      <DisconnectControl
        endpoint={`${kind.apiBase}/-/grant`}
        confirmText={`Revoke these ${kind.label} connections? They are removed from Salesforce too.`}
        buttonLabel="Revoke removed-org connections"
      />
    </ConnectorShell>
  );
}
