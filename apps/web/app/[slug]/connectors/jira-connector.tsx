'use client';

import { useEffect, useState } from 'react';

interface JiraStatus {
  connected: boolean;
  accountId?: string;
  displayName?: string;
}

/**
 * The user's Jira grant: status, connect, disconnect. Talks to the existing
 * /api/mcp/[tenantId] routes — the page around it has already established a
 * session, so a 401 here means it died mid-visit and a refresh re-guards.
 */
export default function JiraConnector({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState<JiraStatus | null>(null);
  // Disconnecting is not reversible without re-authorising Jira, so it asks
  // first rather than acting on one click.
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/mcp/${tenantId}/status`)
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  async function disconnect() {
    setDisconnecting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/mcp/${tenantId}/grant`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.message || data.error || 'Could not disconnect');
        return;
      }
      setStatus({ connected: false });
      setConfirming(false);
      setNotice(data.message ?? 'Disconnected');
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">Jira</h2>
        {status === null ? (
          <span className="text-sm text-gray-500">Checking…</span>
        ) : status.connected ? (
          <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
            Not connected
          </span>
        )}
      </div>

      {status?.connected && status.displayName && (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Connected as <strong>{status.displayName}</strong>
        </p>
      )}

      {notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
      )}

      {status !== null && !status.connected && (
        <a
          href={`/api/mcp/${tenantId}/authorize`}
          className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Connect Jira
        </a>
      )}

      {status?.connected &&
        (confirming ? (
          <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect <strong>{status.displayName ?? 'your Jira account'}</strong>? Tools stop
              working until you reconnect, and any MCP client tokens issued for you are revoked.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void disconnect()}
                disabled={disconnecting}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={disconnecting}
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
            Disconnect Jira
          </button>
        ))}
    </div>
  );
}
