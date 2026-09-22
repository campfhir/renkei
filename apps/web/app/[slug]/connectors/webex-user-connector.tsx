import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import ToggleControl from './toggle-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { WEBEX_SCOPE_GROUPS, WEBEX_USER_SCOPE_OPTIONS } from '@/lib/webex-scopes';

/**
 * The user's own WebEx grant: "Renkei acts on my WebEx." Connection state
 * arrives server-rendered from the page (the grant row either exists or
 * not); the connect/reconnect scope picker and the disconnect confirmation
 * are the only pieces that need a client — everything else here is static
 * given the server-known `connected`/`displayName`/`allSpaces`.
 */
export default function WebexUserConnector({
  tenantId,
  connected,
  displayName,
  allSpaces,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The opt-in all-spaces webhook: agents fire from every space they're in. */
  allSpaces: boolean;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const authorizePath = `/api/webex/${tenantId}/authorize`;

  return (
    <ConnectorShell anchor="card-webex">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="webex" label="WebEx" size={20} />
          WebEx (your account)
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. MCP tools can read your rooms, messages,
            meeting transcripts and recordings — and send a message as you when you explicitly ask
            them to.
          </>
        ) : (
          'Grant Renkei access to your own WebEx: read rooms, messages, meeting transcripts and recordings; capture messages as actionable items; send a message as you when you ask (e.g. a Jira summary to your team).'
        )}
      </p>

      {connected && (
        <CoachTarget name="webex-watch-spaces">
          <div className="mt-3 rounded-md border border-gray-200 p-3 dark:border-gray-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 max-w-md">
                <p className="text-sm font-medium">Watch all my spaces</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Registers a webhook on your own WebEx account covering every space you&apos;re in
                  — including ones you join later. Renkei reacts to new messages in real time (for
                  example, agents you&apos;ve given a message trigger) and indexes them into org
                  knowledge, where a message is only ever readable by people who are currently
                  members of its space. <strong>This includes messages you send yourself</strong>,
                  so an agent can act on something you post. Messages Renkei sent on your behalf
                  are excluded — otherwise an agent that replies would answer itself.
                </p>
              </div>
              <ToggleControl
                endpoint={`/api/webex/${tenantId}/all-spaces`}
                checked={allSpaces}
                ariaLabel="Watch all my spaces"
              />
            </div>
          </div>
        </CoachTarget>
      )}

      {!connected && (
        <ConnectScopePanel
          groups={WEBEX_SCOPE_GROUPS}
          options={WEBEX_USER_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect WebEx"
          scopesAnchor="webex-scopes"
          connectAnchor="webex-connect"
        />
      )}

      {connected && (
        <CoachTarget name="webex-scopes">
          <AuthorizedPermissions
            options={WEBEX_USER_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="WebEx"
          >
            <ReconnectScopePanel
              groups={WEBEX_SCOPE_GROUPS}
              options={WEBEX_USER_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/webex/${tenantId}/grant`}
          confirmText="Disconnect your WebEx account? The WebEx MCP tools stop working until you reconnect."
          buttonLabel="Disconnect WebEx"
        />
      )}
    </ConnectorShell>
  );
}
