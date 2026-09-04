'use client';

import ConnectorIcon from '@/components/connector-icon';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The user's own OnBase grant: "Renkei acts on my OnBase." Connection
 * state arrives server-rendered from the page (the grant row either exists
 * or not); this component carries the connect link and the disconnect
 * confirmation.
 *
 * No scope picker: the Hyland IdP exposes one opaque Document Management
 * scope, so consent is all-or-nothing prose rather than checkboxes. The
 * sign-in itself happens on the organization's own IdP, which lives on the
 * corporate network — the browser can reach it even though the Renkei
 * server cannot.
 *
 * Rendered inside the Hyland suite card (see hyland-connector.tsx)
 * alongside OnBase Administration — a separate Hyland OAuth client with its
 * own grant, so each keeps its own connect/disconnect controls here rather
 * than sharing one at the suite level.
 */
export default function OnBaseConnector({
  tenantId,
  connected,
  displayName,
  nested = false,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  nested?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/onbase/${tenantId}/grant`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.error ?? 'Could not disconnect');
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConnectorShell nested={nested}>
      <div className="flex items-center justify-between gap-4">
        <ConnectorHeading nested={nested}>
          <ConnectorIcon capabilityKey="onbase" label="OnBase" size={20} />
          OnBase (your account)
        </ConnectorHeading>
        {connected ? (
          <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
            Not connected
          </span>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. MCP tools can search, read and file
            documents in your organization&apos;s OnBase as you — everything OnBase lets your
            account see, and nothing more.
          </>
        ) : (
          "Grant Renkei access to your organization's OnBase document management as you: search by keywords or saved custom queries, read documents and their history, upload and index new ones. You sign in on your organization's own Hyland identity provider."
        )}
      </p>

      {notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
      )}

      {!connected && (
        <a
          href={`/api/onbase/${tenantId}/authorize`}
          className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Connect OnBase
        </a>
      )}

      {connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect your OnBase account? The OnBase MCP tools stop working until you reconnect.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void disconnect()}
                disabled={busy}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="mt-3 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
          >
            Disconnect OnBase
          </button>
        ))}
    </ConnectorShell>
  );
}
