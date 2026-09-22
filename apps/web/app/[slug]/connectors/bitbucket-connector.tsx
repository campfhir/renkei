import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import {
  ATLASSIAN_BITBUCKET_SCOPE_GROUPS,
  ATLASSIAN_BITBUCKET_SCOPE_OPTIONS,
} from '@/lib/atlassian-scopes';

/**
 * The user's grant on the fourth Atlassian app ("Renkei Bitbucket") —
 * Bitbucket Cloud on its own OAuth system, its own dedicated grant. Same
 * shape as the Confluence card with one honest difference in the copy:
 * Bitbucket fixes scopes on the OAuth consumer, so unchecking here narrows
 * what Renkei's tools will USE (recorded on the grant), while the consent
 * screen still shows the consumer's full set.
 */
export default function BitbucketConnector({
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
   * own. Affects presentation only — the connect and disconnect controls
   * stay here, on the product they act on.
   */
  nested?: boolean;
}) {
  const authorizePath = `/api/atlassian-bitbucket/${tenantId}/authorize`;

  return (
    <ConnectorShell nested={nested} anchor="card-bitbucket">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          <ConnectorIcon capabilityKey="atlassian-bitbucket" label="Bitbucket" size={20} />
          Bitbucket
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. Repositories, branches, commits, pull
            requests, and pipelines run on this grant.
          </>
        ) : (
          'A separate consent for Bitbucket Cloud — repositories, branches, commits, code search, pull requests, and pipelines. Its own OAuth system, so it lives on its own connection.'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={ATLASSIAN_BITBUCKET_SCOPE_GROUPS}
          options={ATLASSIAN_BITBUCKET_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Bitbucket"
          scopesAnchor="bitbucket-scopes"
          connectAnchor="bitbucket-connect"
          pickerNote={
            <>
              Your organization allows at most these. Uncheck anything you don&apos;t want Renkei
              to use — Bitbucket&apos;s consent screen shows the app&apos;s full set either way,
              but Renkei only exercises what you check here.
            </>
          }
        />
      )}

      {connected && (
        <CoachTarget name="bitbucket-scopes">
          <AuthorizedPermissions
            options={ATLASSIAN_BITBUCKET_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Bitbucket"
          >
            <ReconnectScopePanel
              groups={ATLASSIAN_BITBUCKET_SCOPE_GROUPS}
              options={ATLASSIAN_BITBUCKET_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/atlassian-bitbucket/${tenantId}/grant`}
          confirmText="Disconnect Bitbucket? The Bitbucket tools stop working until you reconnect."
          buttonLabel="Disconnect Bitbucket"
        />
      )}
    </ConnectorShell>
  );
}
