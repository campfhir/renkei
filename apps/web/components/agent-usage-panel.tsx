'use client';

/**
 * One agent's usage (or a roster's, summed) as a stack of cards, one
 * PERIOD at a time: overall tokens, the same tokens by model, and the
 * tool calls by connector.
 * Cards with space between them so each block reads on its own, and so
 * the whole thing stacks on a phone. Presentational: the call sites
 * (the owner's agent page, the admin agent page, the person page with a
 * roster) fetch the rows via
 * `lib/agents/agent-usage.ts`, pre-bucketed, and this picks the bucket.
 */

import { useState } from 'react';
import ConnectorIcon from '@/components/connector-icon';
import PeriodToggle, { periodLabel } from '@/components/period-toggle';
import { ModelUsageRow, TokenStat } from '@/components/token-stat';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { friendlyToolName } from '@/lib/tool-name';
import { modelLabel } from '@/lib/agents/model-label';
import type {
  UsageBuckets,
  TokenUsage,
  AgentToolUsageRow,
  ModelTokenUsage,
} from '@/lib/agents/agent-usage';

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950';
const CARD_TITLE = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

function connectorLabel(key: string | null): string {
  if (!key) return 'Other';
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

function modelKey(row: { provider: string | null; model: string | null }): string {
  return `${row.provider ?? ''}|${row.model ?? ''}`;
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
  byModel,
  tools,
  toolWindowDays,
  defaultPeriod = 'month',
}: {
  tokens: TokenUsage;
  /** The same tokens split by model (098); omitted, the card is not shown. */
  byModel?: ModelTokenUsage[];
  tools: AgentToolUsageRow[];
  toolWindowDays: number;
  defaultPeriod?: keyof UsageBuckets;
}): React.ReactNode {
  const [bucket, setBucket] = useState<keyof UsageBuckets>(defaultPeriod);
  const label = periodLabel(bucket).toLowerCase();
  const empty = <p className="text-sm text-gray-500 dark:text-gray-400">No tokens {label}.</p>;

  const models = (byModel ?? [])
    .filter((row) => row.input[bucket] + row.output[bucket] + row.cacheRead[bucket] > 0)
    .sort(
      (a, b) =>
        b.input[bucket] +
        b.output[bucket] +
        b.cacheRead[bucket] -
        (a.input[bucket] + a.output[bucket] + a.cacheRead[bucket])
    );

  return (
    <div className="space-y-4">
      <PeriodToggle value={bucket} onChange={setBucket} />

      <section className={CARD} aria-label="Overall usage">
        <p className={CARD_TITLE}>Overall · {label}</p>
        <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
          <TokenStat
            label="tokens in"
            value={tokens.input[bucket]}
            cached={tokens.cacheRead[bucket]}
            emphasis
          />
          <TokenStat label="tokens out" value={tokens.output[bucket]} emphasis />
          {tokens.cacheWrite[bucket] > 0 ? (
            <TokenStat label="cache writes" value={tokens.cacheWrite[bucket]} emphasis />
          ) : null}
        </div>
      </section>

      {byModel ? (
        <section className={CARD} aria-label="Model usage">
          <p className={CARD_TITLE}>By model · {label}</p>
          {models.length === 0 ? (
            <div className="mt-1">{empty}</div>
          ) : (
            <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-900">
              {models.map((row) => (
                <ModelUsageRow
                  key={modelKey(row)}
                  name={modelLabel(row.provider, row.model)}
                  input={row.input[bucket]}
                  cached={row.cacheRead[bucket]}
                  output={row.output[bucket]}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className={CARD} aria-label="Tools used">
        <p className={`${CARD_TITLE} mb-2`}>Tools used, last {toolWindowDays} days</p>
        <ToolsByConnector rows={tools} />
      </section>
    </div>
  );
}
