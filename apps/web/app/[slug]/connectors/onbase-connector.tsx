import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import DisconnectControl from './disconnect-control';

/**
 * The user's own OnBase grant: "Renkei acts on my OnBase." Connection
 * state arrives server-rendered from the page (the grant row either exists
 * or not); this component carries the connect link and the disconnect
 * confirmation.
 *
 * No scope picker: the Hyland IdP exposes one opaque Document Management
 * scope, so consent is all-or-nothing prose rather than checkboxes. The
 * sign-in itself happens on the organization's own IdP, which lives on the
 * corporate network — the browser can reach it even though the Renkei
 * server cannot.
 *
 * Rendered inside the Hyland suite card (see hyland-connector.tsx)
 * alongside OnBase Administration — a separate Hyland OAuth client with its
 * own grant, so each keeps its own connect/disconnect controls here rather
 * than sharing one at the suite level.
 */
export default function OnBaseConnector({
  tenantId,
  connected,
  displayName,
  nested = false,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  nested?: boolean;
}) {
  return (
    <ConnectorShell nested={nested} anchor="card-onbase">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          <ConnectorIcon capabilityKey="onbase" label="OnBase" size={20} />
          OnBase (your account)
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. MCP tools can search, read and file
            documents in your organization&apos;s OnBase as you — everything OnBase lets your
            account see, and nothing more.
          </>
        ) : (
          "Grant Renkei access to your organization's OnBase document management as you: search by keywords or saved custom queries, read documents and their history, upload and index new ones. You sign in on your organization's own Hyland identity provider."
        )}
      </p>

      {!connected && (
        <CoachTarget name="onbase-connect" as="span" className="mt-3 inline-block">
          <a
            href={`/api/onbase/${tenantId}/authorize`}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Connect OnBase
          </a>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/onbase/${tenantId}/grant`}
          confirmText="Disconnect your OnBase account? The OnBase MCP tools stop working until you reconnect."
          buttonLabel="Disconnect OnBase"
        />
      )}
    </ConnectorShell>
  );
}
