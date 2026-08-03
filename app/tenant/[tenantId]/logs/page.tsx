'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function LogsViewerContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = params.tenantId as string;
  const accountId = searchParams.get('accountId');
  const operatorKey = searchParams.get('operatorKey');

  const [isOperator] = useState(!!operatorKey);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-black px-4 py-8">
      <main style={{ maxWidth: '90rem' }} className="w-full mx-auto">
        <div className="mb-8">
          <Link href={`/mcp/${tenantId}`} className="text-blue-600 hover:text-blue-700 dark:text-blue-400 text-sm">
            ← Back to MCP endpoint
          </Link>
        </div>

        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">Activity Logs</h1>
          <p className="text-gray-600 dark:text-gray-400">
            {isOperator ? 'Tenant-wide' : 'Your personal'} tool call logs
          </p>
          {accountId && !isOperator && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Account: <code className="text-gray-700 dark:text-gray-300">{accountId}</code>
            </p>
          )}
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-6 space-y-6">
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Logs Powered by @campfhir/bored-logs</h2>
            <p className="text-gray-600 dark:text-gray-400">
              All tool calls are automatically logged with structured data and accessible via bored-logs UI components.
            </p>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6 space-y-4">
            <div className="space-y-3">
              <div>
                <p className="font-semibold text-blue-900 dark:text-blue-100 mb-1">Your Role</p>
                <p className="text-blue-800 dark:text-blue-200">
                  {isOperator ? 'Tenant Operator' : 'Jira User'}
                </p>
              </div>

              <div>
                <p className="font-semibold text-blue-900 dark:text-blue-100 mb-1">Log Access</p>
                <p className="text-blue-800 dark:text-blue-200">
                  {isOperator ? 'View all tool calls across your entire tenant' : 'View only your own tool calls and activity'}
                </p>
              </div>

              <div>
                <p className="font-semibold text-blue-900 dark:text-blue-100 mb-1">What Gets Logged</p>
                <ul className="text-blue-800 dark:text-blue-200 space-y-1 ml-4">
                  <li>✓ Tool name (list_issues, get_issue, get_boards)</li>
                  <li>✓ Success/failure status</li>
                  <li>✓ Error messages (if any)</li>
                  <li>✓ User agent and IP address</li>
                  <li>✓ Timestamp</li>
                </ul>
              </div>

              <div>
                <p className="font-semibold text-blue-900 dark:text-blue-100 mb-1">Log Context</p>
                <code className="text-blue-900 dark:text-blue-100 bg-blue-100 dark:bg-blue-900 px-3 py-2 rounded block mt-2 font-mono text-sm break-all">
                  mcp:{tenantId}{accountId ? `:${accountId}` : ''}
                </code>
              </div>
            </div>
          </div>

          <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-6 space-y-4">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">How to Access Logs</h3>
            <div className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
              {isOperator && (
                <>
                  <p>As a tenant operator, you can:</p>
                  <ol className="list-decimal list-inside space-y-2 ml-2">
                    <li>View all tool calls made by all users in your tenant</li>
                    <li>Filter by user account ID or time range</li>
                    <li>Identify patterns of usage and potential issues</li>
                    <li>Use bored-logs UI components for advanced filtering and search</li>
                  </ol>
                </>
              )}
              {!isOperator && (
                <>
                  <p>As a Jira user, you can:</p>
                  <ol className="list-decimal list-inside space-y-2 ml-2">
                    <li>View your own tool call history</li>
                    <li>See success/failure status of each call</li>
                    <li>Check error messages from failed requests</li>
                    <li>Monitor your API usage patterns</li>
                  </ol>
                </>
              )}
            </div>
          </div>

          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              <strong>Note:</strong> Logs are stored with @campfhir/bored-logs, a PostgreSQL-backed structured logging system with React UI components. Access control is enforced server-side to ensure users can only view logs appropriate for their role.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function LogsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      }
    >
      <LogsViewerContent />
    </Suspense>
  );
}
