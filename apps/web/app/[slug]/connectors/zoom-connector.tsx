import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import CoachTarget from '@/components/coach-marks/anchor';
import AuthorizedPermissions from '@/components/authorized-permissions';
import DisconnectControl from './disconnect-control';
import { ConnectScopePanel, ReconnectScopePanel } from './scope-connect-panel';
import { ZOOM_SCOPE_GROUPS, ZOOM_SCOPE_OPTIONS } from '@/lib/zoom-scopes';

/**
 * The user's own Zoom grant: "Renkei acts on my Zoom." Connection state
 * arrives server-rendered from the page (the grant row either exists or
 * not); this component carries the connect link — the narrowed selection
 * rides the authorize request (granular apps mint exactly it) and is
 * additionally enforced by Renkei at tool registration — and the
 * disconnect confirmation.
 */
export default function ZoomConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
  missingScopes = [],
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /**
   * Requested scopes the minted token did NOT carry. Zoom silently drops
   * any scope missing from the Marketplace app, and the only symptom is
   * tools quietly not registering — so the drift is shown here instead.
   */
  missingScopes?: string[];
}) {
  const authorizePath = `/api/zoom/${tenantId}/authorize`;

  return (
    <ConnectorShell anchor="card-zoom">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="zoom" label="Zoom" size={20} />
          Zoom (your account)
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. MCP tools can read your meetings,
            recordings, transcripts and AI Companion summaries — and schedule or manage a meeting as
            you when you explicitly ask them to.
          </>
        ) : (
          'Grant Renkei access to your own Zoom: read meetings, recordings, transcripts and AI Companion summaries; ingest transcripts into knowledge; schedule or manage a meeting as you when you ask.'
        )}
      </p>

      {connected && missingScopes.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
          <strong>Some requested permissions were not granted.</strong> Zoom only mints scopes that
          exist on the Marketplace app; the tools needing these never register:
          <code className="mt-1 block font-mono text-xs">{missingScopes.join(' ')}</code>
          Add them to the Marketplace app (Scopes → Add Scopes), then disconnect and reconnect.
        </div>
      )}

      {!connected && (
        <ConnectScopePanel
          groups={ZOOM_SCOPE_GROUPS}
          options={ZOOM_SCOPE_OPTIONS}
          ceiling={ceiling}
          priorScopes={priorScopes}
          authorizePath={authorizePath}
          connectLabel="Connect Zoom"
          scopesAnchor="zoom-scopes"
          connectAnchor="zoom-connect"
          extraPickerNote={
            <>
              {' '}
              Zoom&apos;s consent screen shows the permissions this selection requests; unchecked
              capabilities are also enforced by Renkei — their tools never register.
            </>
          }
        />
      )}

      {connected && (
        <CoachTarget name="zoom-scopes">
          <AuthorizedPermissions
            options={ZOOM_SCOPE_OPTIONS}
            authorized={priorScopes}
            connectorLabel="Zoom"
          >
            <ReconnectScopePanel
              groups={ZOOM_SCOPE_GROUPS}
              options={ZOOM_SCOPE_OPTIONS}
              ceiling={ceiling}
              priorScopes={priorScopes}
              authorizePath={authorizePath}
            />
          </AuthorizedPermissions>
        </CoachTarget>
      )}

      {connected && (
        <DisconnectControl
          endpoint={`/api/zoom/${tenantId}/grant`}
          confirmText="Disconnect your Zoom account? The Zoom MCP tools stop working until you reconnect."
          buttonLabel="Disconnect Zoom"
        />
      )}
    </ConnectorShell>
  );
}
