import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { ATLASSIAN_SCOPE_GROUPS, ATLASSIAN_SCOPE_OPTIONS } from '@/lib/atlassian-scopes';
import WatchManager from './watch-manager';

/**
 * The user's Jira grant: status, connect, disconnect. Disconnecting talks to
 * the existing /api/mcp/[tenantId]/grant route.
 *
 * Before connecting, the user may narrow the org's scope ceiling — hide the
 * capabilities they don't want Renkei to have. The authorize route enforces
 * the subset server-side; this picker is the honest UI over that rule.
 *
 * Connection state arrives as a prop from the page, same as its JSM,
 * Confluence and Bitbucket siblings — this used to probe
 * `/api/mcp/[tenantId]/status` client-side on mount instead (a "Checking…"
 * flicker on every load for data the page already had from the same
 * `provider_grants` row it reads for the other three products).
 */
export default function JiraConnector({
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
  const authorizePath = `/api/mcp/${tenantId}/authorize`;

  return (
    <ConnectorShell nested={nested} anchor="card-jira">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          <ConnectorIcon capabilityKey="jira" label="Jira" size={20} />
          Jira
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      {connected && displayName && (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Connected as <strong>{displayName}</strong>
        </p>
      )}

      {!connected && (
        <ConnectScopePanel
          groups={ATLASSIAN_SCOPE_GROUPS}
          options={ATLASSIAN_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Jira"
          scopesAnchor="jira-scopes"
          connectAnchor="jira-connect"
          // Atlassian enforces every documented granular scope per endpoint
          // AND its CDN 414s when the consent redirect chain re-encodes a
          // long authorize URL (observed cliff ≈ 3.1k chars). Some checkbox
          // combinations cannot satisfy both — warn before the user finds
          // out as a CloudFront error page.
          urlBudget={{
            baseChars: 250,
            limit: 2900,
            message: (
              <>
                This combination likely exceeds Atlassian&apos;s consent-URL limit (their CDN
                answers 414). Uncheck a group you don&apos;t need right now — e.g. Service
                Management or Operations — and reconnect later with a different set.
              </>
            ),
          }}
        />
      )}

      {connected && (
        <CoachTarget name="jira-scopes">
          <AuthorizedPermissions
            options={ATLASSIAN_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Jira"
          >
            <ReconnectScopePanel
              groups={ATLASSIAN_SCOPE_GROUPS}
              options={ATLASSIAN_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/mcp/${tenantId}/grant`}
          confirmText={
            <>
              Disconnect <strong>{displayName ?? 'your Jira account'}</strong>? Tools stop working
              until you reconnect, and any MCP client tokens issued for you are revoked.
            </>
          }
          buttonLabel="Disconnect Jira"
          errorFields={['message', 'error']}
        />
      )}

      {connected && <WatchManager tenantId={tenantId} provider="jira" />}
    </ConnectorShell>
  );
}
