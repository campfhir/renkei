'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { signInUrl } from '@/lib/sign-in-url';

interface JiraStatus {
  connected: boolean;
  accountId?: string;
  displayName?: string;
}

export default function MCPEndpoint() {
  const params = useParams();
  const tenantId = typeof params.tenantId === 'string' ? params.tenantId : '';
  const [jiraStatus, setJiraStatus] = useState<JiraStatus>({ connected: false });
  // null until the probe answers, so the page does not flash "sign in" at
  // someone who is already signed in.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  // Disconnecting is not reversible without re-authorising Jira, so it asks
  // first rather than acting on one click.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // Set base URL for display
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin);
    }

    // Check if user has connected Jira auth
    const checkJiraStatus = async () => {
      try {
        const response = await fetch(`/api/mcp/${tenantId}/status`);

        // The endpoint reports only the caller's own grant, so it needs a
        // session. Without one there is nothing to connect *to* yet — sending
        // them to the Jira flow would just 401 again, so ask them to sign in.
        if (response.status === 401) {
          setSignedIn(false);
          setJiraStatus({ connected: false });
          return;
        }

        setSignedIn(true);
        if (response.ok) {
          const data = await response.json();
          if (data.connected) {
            setJiraStatus({
              connected: true,
              accountId: data.accountId,
              displayName: data.displayName,
            });
          }
        }
      } catch {
        // Network failure: leave the sign-in state unknown rather than
        // asserting the user is signed out on no evidence.
        setJiraStatus({ connected: false });
      }
    };

    checkJiraStatus();
  }, [tenantId]);

  const handleAuthorize = async () => {
    // Redirect to Jira OAuth authorization for this tenant
    window.location.href = `/api/mcp/${tenantId}/authorize`;
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/mcp/${tenantId}/grant`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setNotice(data.message || data.error || 'Could not disconnect');
        return;
      }

      setJiraStatus({ connected: false });
      setConfirmingDisconnect(false);
      setNotice(data.message ?? 'Disconnected');
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setDisconnecting(false);
    }
  };

  const mcpEndpointUrl = `${baseUrl}/api/mcp/${tenantId}/http`;

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 dark:bg-black px-4">
      <main style={{ maxWidth: '40rem' }} className="w-full">
        <div className="mb-8">
          <Link href="/" className="text-blue-600 hover:text-blue-700 dark:text-blue-400 text-sm">
            ← Back to sign in
          </Link>
        </div>

        <h1 className="text-3xl font-bold mb-2">MCP Endpoint</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Your Jira work items gateway endpoint.
        </p>

        {/* Full MCP Endpoint URL */}
        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-6 mb-6">
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 font-semibold">
            MCP Endpoint URL
          </p>
          <code className="text-sm text-gray-800 dark:text-gray-200 break-all block font-mono">
            {mcpEndpointUrl}
          </code>
        </div>

        {/* Jira Connection Status */}
        <div
          className={`rounded-lg p-4 mb-6 border ${
            jiraStatus.connected
              ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
              : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'
          }`}
        >
          <h2
            className={`font-semibold mb-2 ${
              jiraStatus.connected
                ? 'text-green-900 dark:text-green-100'
                : 'text-yellow-900 dark:text-yellow-100'
            }`}
          >
            {jiraStatus.connected ? '✓ Jira Connected' : '⚠ Jira Not Connected'}
          </h2>
          {jiraStatus.connected && jiraStatus.displayName ? (
            <p className="text-sm text-green-800 dark:text-green-200">
              Connected as: <strong>{jiraStatus.displayName}</strong>
            </p>
          ) : signedIn === false ? (
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              Sign in to connect your Jira account
            </p>
          ) : (
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              Connect your Jira account to enable work item syncing
            </p>
          )}
        </div>

        {notice && (
          <p className="bg-gray-100 dark:bg-gray-800 rounded-lg p-4 mb-6 text-sm text-gray-800 dark:text-gray-200">
            {notice}
          </p>
        )}

        {/* Setup Steps */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <h2 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">Setup</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800 dark:text-blue-200">
            <li>Connect your Jira account using the button below</li>
            <li>Share this endpoint with your MCP client</li>
          </ol>
        </div>

        {/* Action Buttons */}
        {!jiraStatus.connected &&
          (signedIn === false ? (
            // Straight into this tenant's OIDC flow. This used to point at "/",
            // the home-realm chooser, which starts no flow and leaves the stale
            // session cookie in place — so signing in from here looped back to
            // the same "sign in" prompt.
            <a
              href={signInUrl(tenantId, `/mcp/${tenantId}`)}
              className="w-full block text-center bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors mb-4"
            >
              Sign in
            </a>
          ) : (
            <button
              onClick={handleAuthorize}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors mb-4"
            >
              Connect Jira
            </button>
          ))}

        {jiraStatus.connected &&
          (confirmingDisconnect ? (
            <div className="border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
              <p className="text-sm text-gray-800 dark:text-gray-200 mb-3">
                Disconnect <strong>{jiraStatus.displayName ?? 'your Jira account'}</strong>? Tools
                stop working until you reconnect, and any MCP client tokens issued for you are
                revoked.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="flex-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                </button>
                <button
                  onClick={() => setConfirmingDisconnect(false)}
                  disabled={disconnecting}
                  className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-200 font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDisconnect(true)}
              className="w-full border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 font-medium py-3 px-4 rounded-lg transition-colors mb-4"
            >
              Disconnect Jira
            </button>
          ))}

        <Link
          href={`/tenant/${tenantId}/logs`}
          className="w-full block text-center bg-gray-600 hover:bg-gray-700 text-white font-medium py-3 px-4 rounded-lg transition-colors"
        >
          View Logs
        </Link>

        <p className="text-sm text-gray-600 dark:text-gray-400 mt-6">
          Tenant ID: <code className="text-gray-800 dark:text-gray-200">{tenantId}</code>
        </p>

        <p className="text-center text-sm text-gray-500 dark:text-gray-500 mt-12">
          Renkei — Jira work item gateway
        </p>
      </main>
    </div>
  );
}
