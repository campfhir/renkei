'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';

export default function MCPEndpoint() {
  const params = useParams();
  const tenantId = params.tenantId as string;

  const handleAuthorize = async () => {
    // Redirect to Jira OAuth authorization for this tenant
    window.location.href = `/api/mcp/${tenantId}/authorize`;
  };

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
          Connect your Jira instance to start syncing work items.
        </p>

        <div className="bg-gray-100 dark:bg-gray-900 rounded-lg p-6 mb-6 font-mono text-sm break-all">
          <code className="text-gray-800 dark:text-gray-200">/mcp/{tenantId}</code>
        </div>

        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-6">
          <h2 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">Setup Steps</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800 dark:text-blue-200">
            <li>Configure your organization's identity provider (coming soon)</li>
            <li>Connect your Jira instance using the button below</li>
            <li>Share this endpoint with your MCP client</li>
          </ol>
        </div>

        <button
          onClick={handleAuthorize}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-colors mb-4"
        >
          Connect Jira
        </button>

        <Link
          href={`/tenant/${tenantId}/logs`}
          className="w-full block text-center bg-gray-600 hover:bg-gray-700 text-white font-medium py-3 px-4 rounded-lg transition-colors mb-4"
        >
          View Logs
        </Link>

        <p className="text-sm text-gray-600 dark:text-gray-400">
          Tenant ID: <code className="text-gray-800 dark:text-gray-200">{tenantId}</code>
        </p>

        <p className="text-center text-sm text-gray-500 dark:text-gray-500 mt-12">
          Renkei — Jira work item gateway
        </p>
      </main>
    </div>
  );
}
