'use client';

/**
 * The oversight list as cards, one PERIOD at a time: a single toggle
 * (today, yesterday, this week … all-time) drives the org card and every
 * agent card together. Cards rather than a table because the numbers
 * per agent — runs, failures, tokens in with their cached part, tokens
 * out — read as a small block, which stacks on a phone where a nine-
 * column table only scrolls. A sort control ranks the cards, largest
 * first, so with hundreds of agents the expensive ones are at the top.
 * Client component purely for the toggle and the sort — the data all
 * arrives from the server page, pre-bucketed.
 */

import { useState } from 'react';
import Link from 'next/link';
import LocalTime from '@/components/local-time';
import PeriodToggle, { periodLabel } from '@/components/period-toggle';
import { CountStat, ModelUsageRow, TokenStat } from '@/components/token-stat';
import type { AdminAgentRow } from '@/lib/agents/runs-view';
import type { ModelTokenUsage, TokenUsage, UsageBuckets } from '@/lib/agents/agent-usage';
import { modelLabel } from '@/lib/agents/model-label';
import AdminAgentToggle from './[agentId]/admin-agent-toggle';
import { sortAgentRows, type OversightSortKey } from './oversight-sort';

export type RunBuckets = UsageBuckets;

const SORTS: { key: OversightSortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'runs', label: 'Runs' },
  { key: 'failures', label: 'Failures' },
  { key: 'tokensIn', label: 'Tokens in' },
  { key: 'tokensOut', label: 'Tokens out' },
];

const number = (value: number) => value.toLocaleString('en-US');

const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950';

export default function OversightCards({
  slug,
  agents,
  runsByAgent,
  failuresByAgent,
  tokensByAgent,
  totals,
  failureTotals,
  tokenTotals,
  tokensByModel,
  dailyCap,
}: {
  slug: string;
  agents: AdminAgentRow[];
  runsByAgent: Record<string, RunBuckets>;
  failuresByAgent: Record<string, RunBuckets>;
  tokensByAgent: Record<string, TokenUsage>;
  totals: RunBuckets;
  failureTotals: RunBuckets;
  /** The org's tokens, every purpose — chat and optimizer spend too. */
  tokenTotals: TokenUsage;
  tokensByModel: ModelTokenUsage[];
  dailyCap: number | null;
}): React.ReactNode {
  const [bucket, setBucket] = useState<keyof RunBuckets>('today');
  const [sortKey, setSortKey] = useState<OversightSortKey>('name');

  const ordered = sortAgentRows(agents, sortKey, bucket, {
    runsByAgent,
    failuresByAgent,
    tokensByAgent,
  });
  const modelsInPeriod = tokensByModel.filter(
    (row) => row.input[bucket] + row.output[bucket] + row.cacheRead[bucket] > 0
  );
  const label = periodLabel(bucket).toLowerCase();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PeriodToggle value={bucket} onChange={setBucket} />
        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          Sort by
          <select
            value={sortKey}
            onChange={(event) => {
              const chosen = SORTS.find((sort) => sort.key === event.target.value);
              if (chosen) setSortKey(chosen.key);
            }}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          >
            {SORTS.map((sort) => (
              <option key={sort.key} value={sort.key}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className={CARD} aria-label="Organization">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          All agents · {label}
        </p>
        <p className="mt-2 text-2xl font-semibold tabular-nums">
          {number(totals[bucket])}
          <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
            run{totals[bucket] === 1 ? '' : 's'} across all agents
            {failureTotals[bucket] > 0 ? (
              <>
                {' · '}
                <span className="font-medium text-red-600 dark:text-red-400">
                  {number(failureTotals[bucket])} failed
                </span>
              </>
            ) : null}
            {bucket === 'today' && dailyCap !== null
              ? ` — of the ${number(dailyCap)}-per-day cap`
              : ''}
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
          <TokenStat
            label="tokens in"
            value={tokenTotals.input[bucket]}
            cached={tokenTotals.cacheRead[bucket]}
            emphasis
          />
          <TokenStat label="tokens out" value={tokenTotals.output[bucket]} emphasis />
        </div>
        <div className="mt-4 border-t border-gray-100 pt-3 dark:border-gray-900">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Model usage</p>
          {modelsInPeriod.length === 0 ? (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              No tokens {label === 'all time' ? 'yet' : label}.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-900">
              {modelsInPeriod.map((row) => (
                <ModelUsageRow
                  key={`${row.provider ?? ''}/${row.model ?? ''}`}
                  name={modelLabel(row.provider, row.model)}
                  input={row.input[bucket]}
                  cached={row.cacheRead[bucket]}
                  output={row.output[bucket]}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No agents drafted yet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ordered.map((agent) => {
            const tokens = tokensByAgent[agent.id];
            return (
              <li key={agent.id} className={CARD}>
                <div className="flex items-start justify-between gap-3">
                  <Link
                    href={`/${slug}/admin/agents/${agent.id}`}
                    className="min-w-0 truncate font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {agent.name}
                  </Link>
                  <AdminAgentToggle slug={slug} agentId={agent.id} enabled={agent.enabled} />
                </div>
                <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                  {agent.ownerEmail ?? agent.ownerSubject}
                  {' · '}
                  {agent.lastRunAt ? (
                    <>
                      Last run <LocalTime at={agent.lastRunAt} />
                    </>
                  ) : (
                    'Never run'
                  )}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                  <CountStat
                    label={`runs · ${label}`}
                    value={runsByAgent[agent.id]?.[bucket] ?? 0}
                  />
                  <CountStat
                    label="failed"
                    value={failuresByAgent[agent.id]?.[bucket] ?? 0}
                    tone="danger"
                  />
                  <TokenStat
                    label="tokens in"
                    value={tokens?.input[bucket] ?? 0}
                    cached={tokens?.cacheRead[bucket] ?? 0}
                  />
                  <TokenStat label="tokens out" value={tokens?.output[bucket] ?? 0} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
