'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';

interface LogEntry {
  logged_timestamp?: string | null;
  level?: string;
  message?: string;
  context?: unknown;
  [key: string]: unknown;
}

interface LogsViewerProps {
  initialLogs: LogEntry[];
  initialRole: string | null;
  initialError: string | null;
}

export default function LogsViewerContent({ initialLogs, initialRole, initialError }: LogsViewerProps) {
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = params.tenantId as string;
  const accountId = searchParams.get('accountId');
  const query = searchParams.get('q');

  const [logs, setLogs] = useState<LogEntry[]>(initialLogs);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [searchQuery, setSearchQuery] = useState(query || '');
  const [userRole, setUserRole] = useState<string | null>(initialRole);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const queryOptions: Record<string, string> = {};
        if (searchQuery) {
          queryOptions.query = searchQuery;
        }

        const url = new URL(`/api/tenant/${tenantId}/logs`, window.location.origin);
        if (accountId) {
          url.searchParams.set('accountId', accountId);
        } else {
          url.searchParams.set('isOperator', 'true');
        }

        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(queryOptions),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to fetch logs');
        }

        const data = await response.json();
        setLogs(data.logs || []);
        setUserRole(data.role);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch logs');
      } finally {
        setIsLoading(false);
      }
    };

    if (searchQuery !== (query || '')) {
      fetchLogs();
    }
  }, [tenantId, accountId, searchQuery, query]);

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
            {accountId ? 'Your personal' : 'Tenant-wide'} tool call logs
          </p>
          {accountId && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Account: <code className="text-gray-700 dark:text-gray-300">{accountId}</code>
            </p>
          )}
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-6 space-y-6">
          <div className="space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Search Logs
            </label>
            <input
              type="text"
              placeholder='Filter by bored-logs query syntax (e.g., "level:error && tool:list_issues")'
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Syntax: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">key:value</code> filters,{' '}
              <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">&&</code> (AND),{' '}
              <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">||</code> (OR),{' '}
              <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">()</code> grouping
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Logs Powered by @campfhir/bored-logs</h2>
            <p className="text-gray-600 dark:text-gray-400">
              All tool calls are automatically logged with structured data and accessible via bored-logs UI components.
            </p>
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6 space-y-4">
            <div className="space-y-3">
              <div>
                <p className="font-semibold text-blue-900 dark:text-blue-100 mb-1">Authentication Status</p>
                {userRole === 'renkei-operator' ? (
                  <p className="text-blue-800 dark:text-blue-200">
                    <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2"></span>
                    Authenticated as renkei-operator
                  </p>
                ) : userRole === 'renkei-user' ? (
                  <>
                    <p className="text-blue-800 dark:text-blue-200">
                      <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-2"></span>
                      Authenticated as renkei-user
                    </p>
                    {accountId && (
                      <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                        Jira Account: <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">{accountId}</code>
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-blue-800 dark:text-blue-200">
                    <span className="inline-block w-2 h-2 bg-gray-400 rounded-full mr-2"></span>
                    Loading...
                  </p>
                )}
              </div>

              <div>
                <p className="font-semibold text-blue-900 dark:text-blue-100 mb-1">Permissions</p>
                {userRole === 'renkei-operator' ? (
                  <ul className="text-blue-800 dark:text-blue-200 space-y-1 text-sm">
                    <li>✓ View aggregated logs for entire tenant</li>
                    <li>✓ Manage identity provider configuration</li>
                    <li>✓ Revoke other users' sessions</li>
                  </ul>
                ) : userRole === 'renkei-user' ? (
                  <ul className="text-blue-800 dark:text-blue-200 space-y-1 text-sm">
                    <li>✓ View your own tool call logs</li>
                    <li>✓ Revoke your own sessions</li>
                    <li>✗ Cannot view other users' logs</li>
                  </ul>
                ) : (
                  <p className="text-blue-800 dark:text-blue-200 text-sm">Loading permissions...</p>
                )}
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
              {userRole === 'renkei-operator' && (
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
              {userRole === 'renkei-user' && (
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

          {!isLoading && (
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2 max-h-96 overflow-y-auto">
              {logs.length > 0 && (
                <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                  Found {logs.length} log{logs.length !== 1 ? 's' : ''}
                </div>
              )}
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
                  {logs.map((log, idx) => (
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
              {logs.length === 0 && (
                <div className="text-center py-8 text-gray-600 dark:text-gray-400">
                  No logs found
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
