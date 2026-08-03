'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState, useEffect } from 'react';

function LogsViewerContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = params.tenantId as string;
  const accountId = searchParams.get('accountId');
  const operatorKey = searchParams.get('operatorKey');
  const query = searchParams.get('q'); // Accept q=key:value query param

  const [isOperator] = useState(!!operatorKey);
  const [logs, setLogs] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch logs from API
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Build query options from q parameter
        const queryOptions: Record<string, any> = {};
        if (query) {
          // Parse q=key:value format (bored-logs query syntax)
          queryOptions.filter = query;
        }

        const response = await fetch(`/api/tenant/${tenantId}/logs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(operatorKey ? { 'x-operator-key': operatorKey } : {}),
          },
          body: JSON.stringify(queryOptions),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to fetch logs');
        }

        const data = await response.json();
        setLogs(data.logs || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch logs');
      } finally {
        setIsLoading(false);
      }
    };

    fetchLogs();
  }, [tenantId, accountId, operatorKey, query]);

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

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <p className="text-sm text-red-800 dark:text-red-200">
                <strong>Error:</strong> {error}
              </p>
            </div>
          )}

          {isLoading && (
            <div className="text-center py-8">
              <p className="text-gray-600 dark:text-gray-400">Loading logs...</p>
            </div>
          )}

          {!isLoading && logs.length === 0 && !error && (
            <div className="text-center py-8">
              <p className="text-gray-600 dark:text-gray-400">No logs found</p>
            </div>
          )}

          {!isLoading && logs.length > 0 && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2 max-h-96 overflow-y-auto">
              <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Found {logs.length} log{logs.length !== 1 ? 's' : ''}
              </div>
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 bg-gray-100 dark:bg-gray-700">
                  <tr>
                    <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left font-semibold">Timestamp</th>
                    <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left font-semibold">Level</th>
                    <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left font-semibold">Message</th>
                    <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left font-semibold">Context</th>
                  </tr>
                </thead>
                <tbody className="text-gray-700 dark:text-gray-300">
                  {logs.map((log: any, idx: number) => (
                    <tr key={idx} className="border-t border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                      <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 font-mono whitespace-nowrap">
                        {log.logged_timestamp ? new Date(log.logged_timestamp).toISOString().slice(11, 19) : '—'}
                      </td>
                      <td className="border border-gray-300 dark:border-gray-600 px-2 py-1">
                        <span className={`px-1 rounded text-xs font-semibold ${
                          log.level === 'error' ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100' :
                          log.level === 'warn' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100' :
                          'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100'
                        }`}>
                          {log.level || '—'}
                        </span>
                      </td>
                      <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 truncate max-w-xs">
                        {log.message || '—'}
                      </td>
                      <td className="border border-gray-300 dark:border-gray-600 px-2 py-1 truncate max-w-xs font-mono text-xs">
                        {log.context ? JSON.stringify(log.context).slice(0, 50) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2">
              <strong>Query syntax:</strong> Pass <code className="bg-yellow-100 dark:bg-yellow-900 px-1 rounded">?q=key:value</code> to filter logs (bored-logs query format)
            </p>
            <p className="text-sm text-yellow-800 dark:text-yellow-200">
              <strong>Note:</strong> Logs are stored with @campfhir/bored-logs, a PostgreSQL-backed structured logging system. Access control is enforced server-side to ensure users can only view logs appropriate for their role.
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
