import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import DisconnectControl from './disconnect-control';

/**
 * The user's own OnBase Administration grant: "Renkei configures OnBase as
 * me." A SEPARATE Hyland OAuth client and grant from OnBase above
 * (onbase-connector.tsx) — a person may connect one without the other — so
 * this is a near-duplicate component rather than a shared one, matching
 * how jira-connector.tsx and confluence-connector.tsx are separate files
 * inside the Atlassian suite card.
 *
 * No scope picker: the Hyland IdP exposes one opaque Administration API
 * scope, so consent is all-or-nothing prose rather than checkboxes.
 */
export default function OnBaseAdminConnector({
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
    <ConnectorShell nested={nested} anchor="card-onbase-admin">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          {/* Resolves to the same Hyland mark as OnBase via connector-logos'
              LOGO_FILE map — same vendor/product, its Administration surface. */}
          <ConnectorIcon capabilityKey="onbase-admin" label="OnBase Administration" size={20} />
          OnBase Administration (your account)
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. MCP tools can create and configure document
            types, keyword types and their assignments in your organization&apos;s OnBase as you.
          </>
        ) : (
          "Grant Renkei access to configure your organization's OnBase as you: create and update " +
          'document types and keyword types, and change which keywords a document type has. ' +
          "You sign in on your organization's own Hyland identity provider."
        )}
      </p>

      {!connected && (
        <CoachTarget name="onbase-admin-connect" as="span" className="mt-3 inline-block">
          <a
            href={`/api/onbase-admin/${tenantId}/authorize`}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Connect OnBase Administration
          </a>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/onbase-admin/${tenantId}/grant`}
          confirmText="Disconnect your OnBase Administration account? The onbase_admin_* MCP tools stop working until you reconnect."
          buttonLabel="Disconnect OnBase Administration"
        />
      )}
    </ConnectorShell>
  );
}
