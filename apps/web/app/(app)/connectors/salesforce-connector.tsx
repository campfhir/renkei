import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { SALESFORCE_SCOPE_GROUPS, SALESFORCE_SCOPE_OPTIONS } from '@/lib/salesforce-scopes';

/**
 * The user's grant on the organization's Salesforce app — records, custom
 * objects, activity, and reports, in the org's own Salesforce, with the
 * person's own Salesforce access. Same shape as the GitHub and Entra
 * Developer cards: connection state server-rendered, a connect link that
 * narrows Renkei's capabilities, confirm-gated disconnect.
 */
export default function SalesforceConnector({
  connected,
  displayName,
  username,
  orgHost,
  ceiling,
  priorScopes,
}: {
  connected: boolean;
  displayName: string | null;
  /** The Salesforce username of the connection, shown beside the name. */
  username: string | null;
  /** The org's My Domain host, so a person signs in to the right org. */
  orgHost: string | null;
  /** The org's allowed capabilities — the most a person can grant. */
  ceiling: string[];
  /** Capabilities on the person's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const authorizePath = `/api/salesforce/authorize`;

  return (
    <ConnectorShell anchor="card-salesforce">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="salesforce" label="Salesforce" size={20} />
          Salesforce
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>
            {username && username !== displayName ? <> ({username})</> : null}
            {orgHost ? (
              <>
                {' '}
                to <span className="break-words font-mono text-xs">{orgHost}</span>
              </>
            ) : null}
            . Records, related records and reports are read and changed on this connection, with the
            access you have in Salesforce.
          </>
        ) : (
          <>
            Find and update records — standard objects and your organization&apos;s own custom ones
            — log calls and tasks, and run reports and dashboards, without opening Salesforce.
            Salesforce checks your own access on every call.
            {orgHost ? (
              <>
                {' '}
                You will sign in at <span className="break-words font-mono text-xs">{orgHost}</span>.
              </>
            ) : null}
          </>
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={SALESFORCE_SCOPE_GROUPS}
          options={SALESFORCE_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Salesforce"
          scopesAnchor="salesforce-scopes"
          connectAnchor="salesforce-connect"
        />
      )}

      {connected && (
        <CoachTarget name="salesforce-scopes">
          <AuthorizedPermissions
            options={SALESFORCE_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Salesforce"
          >
            <ReconnectScopePanel
              groups={SALESFORCE_SCOPE_GROUPS}
              options={SALESFORCE_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/salesforce/grant`}
          confirmText="Disconnect Salesforce? Its tools stop working until you reconnect, and the connection is revoked in Salesforce too."
          buttonLabel="Disconnect Salesforce"
        />
      )}
    </ConnectorShell>
  );
}
