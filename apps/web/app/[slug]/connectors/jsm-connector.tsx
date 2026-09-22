import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { ATLASSIAN_JSM_SCOPE_GROUPS, ATLASSIAN_JSM_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';

/**
 * The user's grant on the second Atlassian app ("Renkei JSM": Service
 * Management + Operations scopes on their own grant — the split exists
 * because Atlassian's all-of scope enforcement times its consent-URL length
 * cliff makes the combined scope union unfittable on one app). Same shape as
 * the WebEx card: connection state server-rendered, connect link with scope
 * narrowing, confirm-gated disconnect.
 */
export default function JsmConnector({
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
  const authorizePath = `/api/atlassian-jsm/${tenantId}/authorize`;

  return (
    <ConnectorShell nested={nested} anchor="card-jsm">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          {/* Its own mark, though it shares Jira's capability key. */}
          <ConnectorIcon
            capabilityKey="jira"
            logo="jira-jsm"
            label="Jira Service Management"
            size={20}
          />
          Service Management &amp; Ops
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. Service desk request and Operations
            (alerts, schedules, on-call) tools run on this grant.
          </>
        ) : (
          'A separate Atlassian consent for Jira Service Management and Operations — service desk requests, alerts, schedules, on-call. Atlassian cannot fit these scopes on the Jira consent, so they live on their own connection.'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={ATLASSIAN_JSM_SCOPE_GROUPS}
          options={ATLASSIAN_JSM_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Service Management"
          scopesAnchor="jsm-scopes"
          connectAnchor="jsm-connect"
        />
      )}

      {connected && (
        <CoachTarget name="jsm-scopes">
          <AuthorizedPermissions
            options={ATLASSIAN_JSM_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Jira Service Management"
          >
            <ReconnectScopePanel
              groups={ATLASSIAN_JSM_SCOPE_GROUPS}
              options={ATLASSIAN_JSM_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/atlassian-jsm/${tenantId}/grant`}
          confirmText="Disconnect Service Management? The JSM and Operations tools stop working until you reconnect."
          buttonLabel="Disconnect Service Management"
        />
      )}
    </ConnectorShell>
  );
}
