import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import {
  ATLASSIAN_CONFLUENCE_SCOPE_GROUPS,
  ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
} from '@/lib/atlassian-scopes';
import WatchManager from './watch-manager';

/**
 * The user's grant on the third Atlassian app ("Renkei Confluence") —
 * Confluence's own product API on its own dedicated grant, a different
 * product from Jira/JSM rather than a scope-budget split. Same shape as
 * the JSM card: connection state server-rendered, connect link with scope
 * narrowing, confirm-gated disconnect.
 */
export default function ConfluenceConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
  nested = false,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /**
   * Rendered inside the Atlassian suite card rather than as a card of its
   * own. Affects presentation only: these are three separate OAuth apps with
   * three separate grants, so the connect and disconnect controls stay here,
   * on the product they act on.
   */
  nested?: boolean;
}) {
  const authorizePath = `/api/atlassian-confluence/${tenantId}/authorize`;

  return (
    <ConnectorShell nested={nested} anchor="card-confluence">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          <ConnectorIcon capabilityKey="atlassian-confluence" label="Confluence" size={20} />
          Confluence
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. Spaces, pages, blog posts, comments,
            labels, tasks, attachments, and more run on this grant.
          </>
        ) : (
          'A separate Atlassian consent for Confluence — spaces, pages, blog posts, comments, labels, tasks, attachments, databases, and whiteboards. A different product from Jira, so it lives on its own connection.'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={ATLASSIAN_CONFLUENCE_SCOPE_GROUPS}
          options={ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Confluence"
          scopesAnchor="confluence-scopes"
          connectAnchor="confluence-connect"
        />
      )}

      {connected && (
        <CoachTarget name="confluence-scopes">
          <AuthorizedPermissions
            options={ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Confluence"
          >
            <ReconnectScopePanel
              groups={ATLASSIAN_CONFLUENCE_SCOPE_GROUPS}
              options={ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/atlassian-confluence/${tenantId}/grant`}
          confirmText="Disconnect Confluence? The Confluence tools stop working until you reconnect."
          buttonLabel="Disconnect Confluence"
        />
      )}

      {connected && <WatchManager tenantId={tenantId} provider="confluence" />}
    </ConnectorShell>
  );
}
