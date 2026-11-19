import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import Link from 'next/link';
import { FABRIC_SCOPE_GROUPS, FABRIC_SCOPE_OPTIONS } from '@/lib/fabric-scopes';

/**
 * The user's grant on the Microsoft Fabric app registration — a THIRD
 * Entra app, connected on its own: Entra mints a token for one API, and a
 * Fabric token carries Fabric's scopes only. The Entra Developer card's
 * shape: connection state server-rendered, connect link with scope
 * narrowing, confirm-gated disconnect — plus a way into the Fabric page,
 * where workspaces are browsed and definitions fetched.
 */
export default function FabricConnector({
  connected,
  displayName,
  ceiling,
  priorScopes,
}: {
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const authorizePath = `/api/fabric/authorize`;

  return (
    <ConnectorShell anchor="card-fabric">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="fabric" label="Microsoft Fabric" size={20} />
          Microsoft Fabric
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. Workspaces, lakehouses, notebooks and data
            pipelines are read on this grant, with the role you hold in each workspace. Changes go
            through CI: a pull request on a code project, deployed by its pipeline.{' '}
            <Link href="/fabric" className="text-blue-600 hover:underline dark:text-blue-400">
              Open Fabric
            </Link>
          </>
        ) : (
          'Browse your Fabric workspaces, lakehouses and their tables, and read notebooks and data pipelines. Changes go through CI: notebooks, pipelines and workspaces are proposed as pull requests on a code project and deployed by its pipeline. A separate connection from Microsoft 365 (Fabric is its own API in Entra).'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={FABRIC_SCOPE_GROUPS}
          options={FABRIC_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Microsoft Fabric"
          scopesAnchor="fabric-scopes"
          connectAnchor="fabric-connect"
        />
      )}

      {connected && (
        <CoachTarget name="fabric-scopes">
          <AuthorizedPermissions
            options={FABRIC_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Microsoft Fabric"
          >
            <ReconnectScopePanel
              groups={FABRIC_SCOPE_GROUPS}
              options={FABRIC_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/fabric/grant`}
          confirmText="Disconnect Microsoft Fabric? Its tools stop working until you reconnect, and a definition still being fetched ends unfinished. Your Microsoft 365 connection is not affected."
          buttonLabel="Disconnect Microsoft Fabric"
        />
      )}
    </ConnectorShell>
  );
}
