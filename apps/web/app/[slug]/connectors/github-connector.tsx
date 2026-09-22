import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { GITHUB_SCOPE_GROUPS, GITHUB_SCOPE_OPTIONS } from '@/lib/github-scopes';

/**
 * The user's own grant on Renkei's GitHub App: "Renkei acts on my
 * GitHub." Same shape as ZoomConnector/BitbucketConnector — a GitHub
 * App's real permissions are fixed on the App's registration, so
 * unchecking a capability here decides what Renkei USES, never what
 * GitHub grants (see github-scopes.ts).
 */
export default function GitHubConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed capabilities — the most a user can grant. */
  ceiling: string[];
  /** Capabilities on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const authorizePath = `/api/github/${tenantId}/authorize`;

  return (
    <ConnectorShell anchor="card-github">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="github" label="GitHub" size={20} />
          GitHub
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. Repositories, branches, commits, pull
            requests, code search and Actions run on this grant — for any organization or account
            where Renkei&apos;s GitHub App is installed and you have access.
          </>
        ) : (
          'Repositories, branches, commits, code search, pull requests and Actions, for any organization or account where Renkei’s GitHub App is installed and you have access. Connecting installs the App if it isn’t already, then authorizes it as you.'
        )}
      </p>

      {!connected && (
        <ConnectScopePanel
          groups={GITHUB_SCOPE_GROUPS}
          options={GITHUB_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect GitHub"
          scopesAnchor="github-scopes"
          connectAnchor="github-connect"
          pickerNote={
            <>
              Your organization allows at most these. Uncheck anything you don&apos;t want Renkei
              to use — GitHub&apos;s own permissions are fixed on the App either way, but Renkei
              only exercises what you check here.
            </>
          }
        />
      )}

      {connected && (
        <CoachTarget name="github-scopes">
          <AuthorizedPermissions
            options={GITHUB_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="GitHub"
          >
            <ReconnectScopePanel
              groups={GITHUB_SCOPE_GROUPS}
              options={GITHUB_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/github/${tenantId}/grant`}
          confirmText="Disconnect GitHub? The GitHub tools stop working until you reconnect."
          buttonLabel="Disconnect GitHub"
        />
      )}
    </ConnectorShell>
  );
}
