import {
  LogSearchBar,
  LogTable,
  LogLevelFilter,
  LogDateRangePicker,
  LogSearchSyntaxHelp,
  DEFAULT_QUICK_RANGES,
} from '../../logging/bored-logger-client';
import type { LogDateRange } from '../../logging/bored-logger-client';

interface LogsAppProps {
  tenantSlug: string;
}

export function LogsApp({ tenantSlug }: LogsAppProps) {
  const emptyRange: LogDateRange = { start: null, end: null };

  return (
    <>
      <style>{logsStyles}</style>
      <div id="logs-app" data-slug={tenantSlug}>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <LogLevelFilter value={[]} onChange={() => {}} />
        <LogDateRangePicker value={emptyRange} onChange={() => {}} quickRanges={DEFAULT_QUICK_RANGES} />
        <button id="logs-refresh" disabled style={{ alignSelf: 'center' }}>
          Refresh
        </button>
      </div>

      <LogSearchBar onSearch={() => {}} placeholder="Search logs (e.g., level:error account_id:xyz)" />

      <LogSearchSyntaxHelp />

      <div style={{ overflowX: 'auto', border: '1px solid #ccc', borderRadius: '4px' }}>
        <LogTable sort={{ column: 'logged_timestamp', direction: 'desc' }} onSortChange={() => {}}>
          <tr style={{ textAlign: 'center', color: '#666' }}>
            <td colSpan={3} style={{ padding: '2rem' }}>
              No logs. Click Refresh to fetch logs.
            </td>
          </tr>
        </LogTable>
      </div>

      <div style={{ marginTop: '1rem', padding: '1rem', backgroundColor: '#f9f9f9', borderRadius: '4px' }}>
        <p className="sub">
          <strong>Logs are live in PostgreSQL.</strong> Interactivity is added via JavaScript on the client.
        </p>
      </div>

      <script dangerouslySetInnerHTML={{ __html: logsClientScript(tenantSlug) }} />
      </div>
    </>
  );
}

const logsStyles = `
#logs-app {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

#logs-app [role="group"] {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.75rem;
  background: #fafafa;
  border: 1px solid #ddd;
  border-radius: 6px;
  align-items: center;
}

#logs-app [role="group"] button {
  padding: 0.5rem 0.75rem;
  border: 1px solid #ccc;
  background: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
}

#logs-app [role="group"] button:hover {
  border-color: #999;
  background: #f5f5f5;
}

#logs-app [role="group"] button[data-selected="true"] {
  background: #007bff;
  color: white;
  border-color: #0056b3;
}

#logs-app input[type="text"],
#logs-app input[type="date"],
#logs-app input[type="time"] {
  padding: 0.5rem 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.9rem;
  font-family: inherit;
}

#logs-app input[type="text"]:focus,
#logs-app input[type="date"]:focus,
#logs-app input[type="time"]:focus {
  outline: none;
  border-color: #0066cc;
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
}

#logs-refresh {
  padding: 0.75rem 1.5rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.2s;
}

#logs-refresh:hover:not(:disabled) {
  background: #0056b3;
}

#logs-refresh:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

#logs-app table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

#logs-app thead {
  background: #f5f5f5;
  border-bottom: 2px solid #ddd;
}

#logs-app th {
  padding: 0.75rem;
  text-align: left;
  font-weight: 600;
  color: #333;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

#logs-app th:hover {
  background: #eeeeee;
}

#logs-app td {
  padding: 0.75rem;
  border-bottom: 1px solid #eee;
  word-break: break-word;
}

#logs-app tbody tr:hover {
  background: #fafafa;
}

#logs-app tbody tr:nth-child(odd) {
  background: #fafafa;
}

#logs-app dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.5rem 1rem;
  padding: 1rem;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 0.9rem;
}

#logs-app dt {
  font-weight: 600;
  color: #333;
  font-family: monospace;
}

#logs-app dd {
  margin: 0;
  color: #666;
}

#logs-app > div:last-child {
  margin-top: 1rem;
  padding: 1rem;
  background: #f0f7ff;
  border-left: 4px solid #0066cc;
  border-radius: 4px;
}

#logs-app > div:last-child p {
  margin: 0;
  font-size: 0.9rem;
  color: #003d99;
}

#logs-app code {
  font-family: monospace;
  background: rgba(0, 0, 0, 0.05);
  padding: 0.2em 0.4em;
  border-radius: 2px;
}
`;

function logsClientScript(tenantSlug: string): string {
  return `
(function() {
  const app = document.getElementById('logs-app');
  const refreshBtn = document.getElementById('logs-refresh');

  refreshBtn.disabled = false;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const params = new URLSearchParams();
      params.append('q', "level:'info'");

      const response = await fetch('/api/admin/${tenantSlug}/logs?' + params);
      const data = await response.json();
      console.log('Fetched logs:', data);
    } catch (e) {
      console.error('Failed to fetch logs:', e);
    } finally {
      refreshBtn.disabled = false;
    }
  });

  console.log('Logs app initialized for tenant:', app.dataset.slug);
})();
  `;
}
