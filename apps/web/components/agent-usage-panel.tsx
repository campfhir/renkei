/**
 * One agent's usage: token spend by period, and tool calls grouped by
 * connector — the same connector-grouped-list idea the org-wide tools page
 * uses (`app/[slug]/usage/usage-viewer.tsx`), scoped to a single agent's
 * data instead of `tool_calls`. Presentational only — both call sites
 * (the owner's agent page and the admin agent detail page) fetch the rows
 * themselves via `lib/agents/agent-usage.ts`, since what each may see
 * differs (see that module's doc comment).
 */

import ConnectorIcon from '@/components/connector-icon';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { friendlyToolName } from '@/lib/tool-name';
import type { UsageBuckets, AgentToolUsageRow } from '@/lib/agents/agent-usage';

function connectorLabel(key: string | null): string {
  if (!key) return 'Other';
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

const BUCKETS: { key: keyof UsageBuckets; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'allTime', label: 'All time' },
];

function TokenBuckets({ input, output }: { input: UsageBuckets; output: UsageBuckets }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th className="pb-1 pr-3 font-medium" />
            {BUCKETS.map((bucket) => (
              <th key={bucket.key} className="pb-1 pr-3 text-right font-medium">
                {bucket.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3 text-gray-500 dark:text-gray-400">Tokens in</td>
            {BUCKETS.map((bucket) => (
              <td key={bucket.key} className="pr-3 text-right tabular-nums">
                {input[bucket.key].toLocaleString('en-US')}
              </td>
            ))}
          </tr>
          <tr>
            <td className="pr-3 text-gray-500 dark:text-gray-400">Tokens out</td>
            {BUCKETS.map((bucket) => (
              <td key={bucket.key} className="pr-3 text-right tabular-nums">
                {output[bucket.key].toLocaleString('en-US')}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function ToolsByConnector({ rows }: { rows: AgentToolUsageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">No tool calls in this window.</p>
    );
  }
  const peak = Math.max(1, ...rows.map((row) => row.calls));
  const groups = new Map<string | null, AgentToolUsageRow[]>();
  for (const row of rows) {
    const list = groups.get(row.connector) ?? [];
    list.push(row);
    groups.set(row.connector, list);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) =>
      b[1].reduce((sum, row) => sum + row.calls, 0) - a[1].reduce((sum, row) => sum + row.calls, 0)
  );

  return (
    <div className="space-y-4">
      {ordered.map(([connector, toolRows]) => (
        <div key={connector ?? 'other'}>
          <div className="mb-1.5 flex items-center gap-1.5">
            {connector ? (
              <ConnectorIcon
                capabilityKey={connector}
                label={connectorLabel(connector)}
                size={16}
              />
            ) : null}
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {connectorLabel(connector)}
            </span>
          </div>
          <ul className="space-y-1.5">
            {toolRows.map((row) => (
              <li key={row.tool} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate" title={row.tool}>
                    {friendlyToolName(row.tool, null)}
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
                    {row.calls.toLocaleString('en-US')}
                    {row.errors > 0 ? (
                      <span className="ml-1.5 font-medium text-red-600 dark:text-red-400">
                        {row.errors.toLocaleString('en-US')} failed
                      </span>
                    ) : null}
                    {row.p95Ms > 0 ? (
                      <span className="ml-1.5 text-gray-400" title="95th percentile latency">
                        p95 {formatMs(row.p95Ms)}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${(row.calls / peak) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function AgentUsagePanel({
  tokens,
  tools,
  toolWindowDays,
}: {
  tokens: { input: UsageBuckets; output: UsageBuckets };
  tools: AgentToolUsageRow[];
  toolWindowDays: number;
}): React.ReactNode {
  return (
    <div className="space-y-5">
      <TokenBuckets input={tokens.input} output={tokens.output} />
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Tools used, last {toolWindowDays} days
        </p>
        <ToolsByConnector rows={tools} />
      </div>
    </div>
  );
}
