import Link from 'next/link';
import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import {
  ATLASSIAN_ADMIN_SCOPE_GROUPS,
  ATLASSIAN_ADMIN_SCOPE_OPTIONS,
} from '@/lib/atlassian-scopes';

/**
 * The user's grant on the fifth Atlassian app ("Renkei Jira Admin") — Jira
 * administration on its own app with classic scopes, so it connects
 * separately from Jira even for someone already connected there. Same shape
 * as the Confluence card: connection state server-rendered, connect link
 * with scope narrowing, confirm-gated disconnect.
 */
export default function JiraAdminConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
  changesHref,
  pendingChanges,
  nested = false,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /** The review list for this person's proposed admin changes. */
  changesHref: string;
  /** How many of them are waiting for review. */
  pendingChanges: number;
  /**
   * Rendered inside the Atlassian suite card rather than as a card of its
   * own. Presentation only: the connect and disconnect controls stay here,
   * on the product they act on.
   */
  nested?: boolean;
}) {
  const authorizePath = `/api/atlassian-admin/${tenantId}/authorize`;

  return (
    <ConnectorShell nested={nested} anchor="card-jira-admin">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          <ConnectorIcon capabilityKey="jira-admin" label="Jira Administration" size={20} />
          Jira Administration
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. Custom fields and their options, space
            configuration and Plans are read on this grant, with the Jira permissions you hold.
            Changes are proposed first, and reach Jira only when you apply them.
          </>
        ) : (
          'For Jira admins: custom fields and their options, how each space is configured, and Plans. A separate Atlassian app from Jira, so it connects on its own — and Jira still checks your admin rights on every call.'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={ATLASSIAN_ADMIN_SCOPE_GROUPS}
          options={ATLASSIAN_ADMIN_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Jira Administration"
          scopesAnchor="jira-admin-scopes"
          connectAnchor="jira-admin-connect"
        />
      )}

      {connected && (
        <p className="mt-2 text-sm">
          <Link
            href={changesHref}
            data-testid="jira-admin-changes-link"
            className="font-medium text-blue-700 hover:underline dark:text-blue-400"
          >
            {pendingChanges > 0
              ? `${pendingChanges} proposed ${pendingChanges === 1 ? 'change' : 'changes'} waiting for your review`
              : 'Proposed changes'}
          </Link>
        </p>
      )}

      {connected && (
        <CoachTarget name="jira-admin-scopes">
          <AuthorizedPermissions
            options={ATLASSIAN_ADMIN_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Jira Administration"
          >
            <ReconnectScopePanel
              groups={ATLASSIAN_ADMIN_SCOPE_GROUPS}
              options={ATLASSIAN_ADMIN_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/atlassian-admin/${tenantId}/grant`}
          confirmText="Disconnect Jira Administration? Its tools stop working until you reconnect. Your Jira connection is not affected."
          buttonLabel="Disconnect Jira Administration"
        />
      )}
    </ConnectorShell>
  );
}
