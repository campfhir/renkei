'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The user's own WebEx grant: "Renkei reads WebEx as me." Connection state
 * arrives server-rendered from the page (the grant row either exists or
 * not); this component only carries the connect link and the disconnect
 * confirmation.
 */
export default function WebexUserConnector({
  tenantId,
  connected,
  displayName,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/webex/${tenantId}/grant`, { method: 'DELETE' });
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
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">WebEx (your account)</h2>
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
            Connected as <strong>{displayName}</strong>. MCP tools can read the rooms you are in —
            they never post as you.
          </>
        ) : (
          'Grant Renkei read access to your own WebEx: list your rooms, read messages you can see, capture them as actionable items. Read-only.'
        )}
      </p>

      {notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
      )}

      {!connected && (
        <a
          href={`/api/webex/${tenantId}/authorize`}
          className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Connect WebEx
        </a>
      )}

      {connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect your WebEx account? The WebEx MCP tools stop working until you reconnect.
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
            Disconnect WebEx
          </button>
        ))}
    </div>
  );
}
