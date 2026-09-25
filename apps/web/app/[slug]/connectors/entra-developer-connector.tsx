import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import {
  ENTRA_DEVELOPER_SCOPE_GROUPS,
  ENTRA_DEVELOPER_SCOPE_OPTIONS,
} from '@/lib/entra-developer-scopes';

/**
 * The user's grant on the Entra Developer app registration — application
 * provisioning on a SECOND Entra app with directory-wide permissions, so it
 * connects separately from Microsoft 365 even for someone already
 * connected there. A card of its own rather than a panel inside the
 * Microsoft 365 card: that card is one consent covering every product, and
 * this is a different consent on a different app. Same shape as the Jira
 * Administration and GitHub cards: connection state server-rendered,
 * connect link with scope narrowing, confirm-gated disconnect.
 */
export default function EntraDeveloperConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const authorizePath = `/api/entra-developer/${tenantId}/authorize`;

  return (
    <ConnectorShell anchor="card-entra-developer">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="entra-developer" label="Entra Developer" size={20} />
          Entra Developer
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. App registrations, enterprise applications,
            app roles and their assignments are read and provisioned on this grant, with the Entra
            rights you hold. Every change is a card you confirm first.
          </>
        ) : (
          'For developers and app owners: create app registrations and enterprise applications, define their app roles, and assign users and groups to those roles — each change confirmed on a card. A separate Entra app from Microsoft 365, so it connects on its own; Entra still checks what you may create or own on every call.'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={ENTRA_DEVELOPER_SCOPE_GROUPS}
          options={ENTRA_DEVELOPER_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Entra Developer"
          scopesAnchor="entra-developer-scopes"
          connectAnchor="entra-developer-connect"
        />
      )}

      {connected && (
        <CoachTarget name="entra-developer-scopes">
          <AuthorizedPermissions
            options={ENTRA_DEVELOPER_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Entra Developer"
          >
            <ReconnectScopePanel
              groups={ENTRA_DEVELOPER_SCOPE_GROUPS}
              options={ENTRA_DEVELOPER_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/entra-developer/${tenantId}/grant`}
          confirmText="Disconnect Entra Developer? Its tools stop working until you reconnect. Your Microsoft 365 connection is not affected."
          buttonLabel="Disconnect Entra Developer"
        />
      )}
    </ConnectorShell>
  );
}
