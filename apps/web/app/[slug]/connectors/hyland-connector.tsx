import ConnectorIcon from '@/components/connector-icon';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import OnBaseConnector from './onbase-connector';
import OnBaseAdminConnector from './onbase-admin-connector';

/**
 * The Hyland suite: OnBase and OnBase Administration, grouped under one
 * heading — the same treatment atlassian-connector.tsx gives Jira/JSM/
 * Confluence/Bitbucket, and for the identical reason: these are two
 * separate Hyland OAuth clients with two separate grants (a document-access
 * client and a configuration client the customer may register, connect and
 * revoke independently), not one consent covering both. Each product below
 * therefore keeps its own connect, disconnect and status controls, on the
 * product it acts on — a shared control at the foot of this card would
 * imply one Hyland consent that does not exist.
 *
 * A server component: it holds no state, and every product below manages
 * its own.
 */
export default function HylandConnector({
  tenantId,
  onbase,
  onbaseAdmin,
}: {
  tenantId: string;
  /** Absent when the org has not enabled OnBase. */
  onbase?: { connected: boolean; displayName: string | null };
  /** Absent when the org has not enabled OnBase Administration. */
  onbaseAdmin?: { connected: boolean; displayName: string | null };
}) {
  return (
    <ConnectorShell>
      <ConnectorHeading>
        <ConnectorIcon capabilityKey="onbase" label="Hyland" size={20} />
        Hyland
      </ConnectorHeading>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Separate connections per product — OnBase document access and OnBase configuration are
        different Hyland OAuth clients. Connect each you want; they are independent, and
        connecting one does not affect the other.
      </p>

      <div className="mt-3 space-y-3">
        {onbase ? (
          <OnBaseConnector
            nested
            tenantId={tenantId}
            connected={onbase.connected}
            displayName={onbase.displayName}
          />
        ) : (
          <ConnectorShell nested>
            <ConnectorHeading nested>
              <ConnectorIcon capabilityKey="onbase" label="OnBase" size={20} />
              OnBase
            </ConnectorHeading>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              Not enabled for this organization. An org admin can set it up under Connector setup.
            </p>
          </ConnectorShell>
        )}

        {onbaseAdmin && (
          <OnBaseAdminConnector
            nested
            tenantId={tenantId}
            connected={onbaseAdmin.connected}
            displayName={onbaseAdmin.displayName}
          />
        )}
      </div>
    </ConnectorShell>
  );
}
