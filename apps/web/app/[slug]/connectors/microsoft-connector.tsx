import ConnectorIcon from '@/components/connector-icon';
import ConnectorStatusBadge from '@/components/connector-status-badge';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import MicrosoftConnectBody from './microsoft-connect-body';

/**
 * The user's own Microsoft 365 connection: one card, containing a panel per
 * product — Outlook, OneDrive, SharePoint, the directory — and one set of
 * connect / disconnect / re-authorize controls at its foot.
 *
 * The shape follows the grant. Microsoft issues a SINGLE consent covering
 * every product, and a re-consent REPLACES it rather than adding to it. So
 * there is exactly one authorize URL, built from the union of every panel's
 * selections. An earlier pass gave each product its own card and its own
 * Approve button, which was a trap dressed as symmetry: a per-card URL would
 * carry only that product's scopes, and approving a SharePoint tweak would
 * silently revoke mail, calendar and files — no error, no warning, just tools
 * quietly missing from the list afterwards. Every card had to carry a
 * paragraph explaining that its button did something other than what its
 * position implied.
 *
 * Containing the panels states it structurally instead. The products are
 * visibly inside one connection; the control that acts on the whole
 * connection sits at the bottom of the thing it acts on, once.
 *
 * This component owns only the header and description, which depend on
 * nothing a click changes — `connected`/`displayName` arrive server-rendered
 * from the page, same as every other card here. The scope selection lifted
 * across panels, and the connect/re-authorize/disconnect controls that read
 * it, live in `MicrosoftConnectBody` (a client island) below.
 */
export default function MicrosoftConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
  shownKeys,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /**
   * Which products' panels to show, by capability key — the ones this
   * person added or connected. The consent is still one consent: a hidden
   * panel's scopes are simply not offered, the same as unticking them.
   */
  shownKeys: string[];
}) {
  return (
    <ConnectorShell anchor="card-microsoft">
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading>
          <ConnectorIcon capabilityKey="microsoft" label="Microsoft 365" size={20} />
          Microsoft 365 (your account)
        </ConnectorHeading>
        <ConnectorStatusBadge connected={connected} />
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. One connection covers every product below.
          </>
        ) : (
          'Grant Renkei access to your own Microsoft 365. Choose what each product may do, then connect once — Microsoft asks for all of it in a single approval.'
        )}
      </p>

      <MicrosoftConnectBody
        tenantId={tenantId}
        connected={connected}
        ceiling={ceiling}
        priorScopes={priorScopes}
        shownKeys={shownKeys}
      />
    </ConnectorShell>
  );
}
