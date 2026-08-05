'use client';

import { useState } from 'react';
import {
  LogSearchBar,
  LogTable,
  LogTableRowGroup,
  LogLevelFilter,
  LogDateRangePicker,
  LogSearchSyntaxHelp,
  DEFAULT_QUICK_RANGES,
} from '@/lib/logging/bored-logger-client';
import type { LogDateRange, SortState } from '@/lib/logging/bored-logger-client';

interface LogsClientAppProps {
  tenantSlug: string;
}

interface LogRow {
  id: string;
  level: string;
  message: string;
  meta: { [key: string]: unknown };
  timestamp: string | null;
}

function isLogsResponse(data: unknown): data is { logs: unknown[] } {
  if (typeof data !== 'object' || data === null) return false;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.logs);
}

export function LogsClientApp({ tenantSlug }: LogsClientAppProps) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryString, setQueryString] = useState('');
  const [levels, setLevels] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<LogDateRange>({ start: null, end: null });
  const [sortState, setSortState] = useState<SortState>({ column: 'logged_timestamp', direction: 'desc' });

  // Build query string from filters
  const buildQuery = (newLevels?: string[], newDateRange?: LogDateRange): string => {
    const parts: string[] = [];
    const effectiveLevels = newLevels ?? levels;
    const effectiveDateRange = newDateRange ?? dateRange;

    if (effectiveLevels.length > 0) {
      const levelQuery = effectiveLevels.map((l) => `level:'${l}'`).join(' || ');
      parts.push(effectiveLevels.length > 1 ? `(${levelQuery})` : levelQuery);
    }

    if (effectiveDateRange.start) {
      parts.push(`timestamp:>='${effectiveDateRange.start}'`);
    }
    if (effectiveDateRange.end) {
      parts.push(`timestamp:<='${effectiveDateRange.end}'`);
    }

    return parts.join(' && ');
  };

  const fetchLogs = async (q: string = '') => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.append('q', q);
      params.append('sort', JSON.stringify(sortState));

      const response = await fetch(`/api/admin/${tenantSlug}/logs?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch logs: ${response.statusText}`);
      }
      const data = await response.json();
      if (isLogsResponse(data)) {
        // Transform API response to LogRow format
        const transformedLogs = (data.logs as unknown[]).map((log: unknown) => {
          if (typeof log !== 'object' || log === null) {
            return null;
          }
          const logObj = log as Record<string, unknown>;
          return {
            id: String(logObj.log_id || ''),
            level: String(logObj.level || 'info'),
            message: String(logObj.message || ''),
            meta: {},
            timestamp: logObj.logged_timestamp ? String(logObj.logged_timestamp) : null,
          };
        }).filter((log): log is LogRow => log !== null);
        setLogs(transformedLogs);
      } else {
        setLogs([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLogs([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLevelChange = (newLevels: string[]) => {
    setLevels(newLevels);
    const q = buildQuery(newLevels, dateRange);
    setQueryString(q);
    fetchLogs(q);
  };

  const handleDateRangeChange = (newRange: LogDateRange) => {
    setDateRange(newRange);
    const q = buildQuery(levels, newRange);
    setQueryString(q);
    fetchLogs(q);
  };

  const handleRefresh = () => {
    fetchLogs(queryString);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <style>{logsClientStyles}</style>

      <div id="logs-filters" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <LogLevelFilter value={levels} onChange={handleLevelChange} />
        <LogDateRangePicker value={dateRange} onChange={handleDateRangeChange} quickRanges={DEFAULT_QUICK_RANGES} />
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="logs-refresh-btn"
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          style={{
            padding: '0.75rem 1.5rem',
            background: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            fontSize: '1rem',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            opacity: isLoading ? 0.6 : 1,
            alignSelf: 'center',
            transition: 'background 0.2s',
          } as React.CSSProperties}
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <LogSearchBar
        onSearch={() => {}}
        placeholder="Search logs (e.g., level:error account_id:xyz)"
        logs={logs}
      />

      <LogSearchSyntaxHelp />

      {error && (
        <div
          style={{
            padding: '1rem',
            background: '#fee',
            border: '1px solid #fcc',
            color: '#c33',
            borderRadius: '4px',
            fontSize: '0.9rem',
          }}
        >
          Error: {error}
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid #ccc', borderRadius: '4px' }}>
        <LogTable sort={sortState} onSortChange={setSortState}>
          {isLoading ? (
            <tr style={{ textAlign: 'center', color: '#666' }}>
              <td colSpan={3} style={{ padding: '2rem' }}>
                Loading logs...
              </td>
            </tr>
          ) : logs.length === 0 ? (
            <tr style={{ textAlign: 'center', color: '#666' }}>
              <td colSpan={3} style={{ padding: '2rem' }}>
                No logs found. Adjust filters or click Refresh.
              </td>
            </tr>
          ) : (
            logs.map((log, idx) => (
              <LogTableRowGroup key={String(log.id ?? idx)} log={log}>
                <pre style={{ margin: 0, fontSize: '0.85em', maxHeight: '300px', overflow: 'auto' }}>
                  {JSON.stringify(log, null, 2)}
                </pre>
              </LogTableRowGroup>
            ))
          )}
        </LogTable>
      </div>

      <div style={{ marginTop: '1rem', padding: '1rem', backgroundColor: '#f0f7ff', borderLeft: '4px solid #0066cc', borderRadius: '4px' }}>
        <p style={{ margin: 0, fontSize: '0.9rem', color: '#003d99' }}>
          <strong>Logs are stored in PostgreSQL.</strong> Use the filters above to search and navigate application
          error logs in real time.
        </p>
      </div>
    </div>
  );
}

const logsClientStyles = `
#logs-filters {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: flex-start;
}

#logs-filters [role="group"] {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.75rem;
  background: #fafafa;
  border: 1px solid #ddd;
  border-radius: 6px;
  align-items: center;
}

#logs-filters [role="group"] button {
  padding: 0.5rem 0.75rem;
  border: 1px solid #ccc;
  background: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}

#logs-filters [role="group"] button:hover {
  border-color: #999;
  background: #f5f5f5;
}

#logs-filters [role="group"] button[data-selected="true"] {
  background: #007bff;
  color: white;
  border-color: #0056b3;
}

input[type="text"],
input[type="date"],
input[type="time"] {
  padding: 0.5rem 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.9rem;
  font-family: inherit;
}

input[type="text"]:focus,
input[type="date"]:focus,
input[type="time"]:focus {
  outline: none;
  border-color: #0066cc;
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

thead {
  background: #f5f5f5;
  border-bottom: 2px solid #ddd;
}

th {
  padding: 0.75rem;
  text-align: left;
  font-weight: 600;
  color: #333;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

th:hover {
  background: #eeeeee;
}

td {
  padding: 0.75rem;
  border-bottom: 1px solid #eee;
  word-break: break-word;
}

tbody tr:hover {
  background: #fafafa;
}

tbody tr:nth-child(odd) {
  background: #fafafa;
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.5rem 1rem;
  padding: 1rem;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 0.9rem;
}

dt {
  font-weight: 600;
  color: #333;
  font-family: monospace;
}

dd {
  margin: 0;
  color: #666;
}

code {
  font-family: monospace;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.2em 0.4em;
  border-radius: 2px;
}
`;
