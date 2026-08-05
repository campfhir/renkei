'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface JiraStatus {
  connected: boolean;
  accountId?: string;
  displayName?: string;
}

export default function MCPEndpoint() {
  const params = useParams();
  const tenantId = params.tenantId as string;
  const [jiraStatus, setJiraStatus] = useState<JiraStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    // Set base URL for display
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin);
    }

    // Check if user has connected Jira auth
    const checkJiraStatus = async () => {
      try {
        const response = await fetch(`/api/mcp/${tenantId}/status`);
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
      } catch (error) {
        // User hasn't connected Jira yet
        setJiraStatus({ connected: false });
      } finally {
        setLoading(false);
      }
    };

    checkJiraStatus();
  }, [tenantId]);

  const handleAuthorize = async () => {
    // Redirect to Jira OAuth authorization for this tenant
    window.location.href = `/api/mcp/${tenantId}/authorize`;
  };

  const mcpEndpointUrl = `${baseUrl}/api/mcp/${tenantId}/sse`;

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
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 font-semibold">MCP Endpoint URL</p>
          <code className="text-sm text-gray-800 dark:text-gray-200 break-all block font-mono">{mcpEndpointUrl}</code>
        </div>

        {/* Jira Connection Status */}
        <div className={`rounded-lg p-4 mb-6 border ${
          jiraStatus.connected
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'
        }`}>
          <h2 className={`font-semibold mb-2 ${
            jiraStatus.connected
              ? 'text-green-900 dark:text-green-100'
              : 'text-yellow-900 dark:text-yellow-100'
          }`}>
            {jiraStatus.connected ? '✓ Jira Connected' : '⚠ Jira Not Connected'}
          </h2>
          {jiraStatus.connected && jiraStatus.displayName ? (
            <p className="text-sm text-green-800 dark:text-green-200">
              Connected as: <strong>{jiraStatus.displayName}</strong>
            </p>
          ) : (
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              Connect your Jira account to enable work item syncing
            </p>
          )}
        </div>

        {/* Setup Steps */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <h2 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">Setup</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800 dark:text-blue-200">
            <li>Connect your Jira account using the button below</li>
            <li>Share this endpoint with your MCP client</li>
          </ol>
        </div>

        {/* Action Buttons */}
        {!jiraStatus.connected && (
          <button
            onClick={handleAuthorize}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors mb-4"
          >
            Connect Jira
          </button>
        )}

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
