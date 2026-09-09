'use client';

/**
 * The oversight list with its run tallies, one PERIOD at a time: a single
 * toggle (today … all-time) drives the org-wide total, the per-agent Runs,
 * Failures, Tokens in and Tokens out columns together, instead of a dozen
 * number columns shouting at once. Any numeric column header sorts the
 * list by it, largest first — with hundreds of agents the question is
 * "which one costs the most", and that is the top of a descending list.
 * Client component purely for the toggle and the sort — the data all
 * arrives from the server page, pre-bucketed.
 */

import { useState } from 'react';
import Link from 'next/link';
import LocalTime from '@/components/local-time';
import type { AdminAgentRow } from '@/lib/agents/runs-view';
import type { ModelTokenUsage } from '@/lib/agents/agent-usage';
import { modelLabel } from '@/lib/agents/model-label';
import { AdminAgentActions } from './admin-agent-actions';
import { sortAgentRows, type OversightSortKey } from './oversight-sort';

export interface RunBuckets {
  today: number;
  week: number;
  month: number;
  quarter: number;
  year: number;
  allTime: number;
}

const BUCKETS: { key: keyof RunBuckets; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'allTime', label: 'All time' },
];

const number = (value: number) => value.toLocaleString('en-US');

export default function OversightTable({
  slug,
  agents,
  runsByAgent,
  failuresByAgent,
  tokensInByAgent,
  tokensOutByAgent,
  totals,
  failureTotals,
  tokenInTotals,
  tokenOutTotals,
  tokensByModel,
  dailyCap,
}: {
  slug: string;
  agents: AdminAgentRow[];
  runsByAgent: Record<string, RunBuckets>;
  failuresByAgent: Record<string, RunBuckets>;
  tokensInByAgent: Record<string, RunBuckets>;
  tokensOutByAgent: Record<string, RunBuckets>;
  totals: RunBuckets;
  failureTotals: RunBuckets;
  tokenInTotals: RunBuckets;
  tokenOutTotals: RunBuckets;
  /** The org's tokens split by model, every purpose — chat and optimizer spend too. */
  tokensByModel: ModelTokenUsage[];
  dailyCap: number | null;
}): React.ReactNode {
  const [bucket, setBucket] = useState<keyof RunBuckets>('today');
  const [sortKey, setSortKey] = useState<OversightSortKey>('name');
  const bucketLabel = BUCKETS.find((option) => option.key === bucket)?.label.toLowerCase();

  const tallies = { runsByAgent, failuresByAgent, tokensInByAgent, tokensOutByAgent };
  const ordered = sortAgentRows(agents, sortKey, bucket, tallies);
  const modelsInPeriod = tokensByModel.filter(
    (row) => row.input[bucket] + row.output[bucket] + row.cacheRead[bucket] > 0
  );

  function SortHeader({ column, label }: { column: OversightSortKey; label: string }) {
    const active = sortKey === column;
    return (
      <th
        className="py-2 pr-3 text-right"
        aria-sort={active ? (column === 'name' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => setSortKey(column)}
          className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-800 dark:hover:text-gray-200 ${
            active ? 'text-gray-800 dark:text-gray-200' : ''
          }`}
          title={`Sort by ${label.toLowerCase()}`}
        >
          {label}
          {active ? <span aria-hidden="true">▾</span> : null}
        </button>
      </th>
    );
  }

  return (
    <div>
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Runs started
          </p>
          <div className="flex flex-wrap overflow-hidden rounded-md border border-gray-300 text-xs dark:border-gray-700">
            {BUCKETS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setBucket(option.key)}
                className={`px-2.5 py-1 ${
                  bucket === option.key
                    ? 'bg-gray-700 text-white dark:bg-gray-300 dark:text-gray-900'
                    : 'text-gray-600 dark:text-gray-400'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
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
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          <span className="tabular-nums">{number(tokenInTotals[bucket])}</span> tokens in ·{' '}
          <span className="tabular-nums">{number(tokenOutTotals[bucket])}</span> tokens out, across
          all agents
        </p>
        {modelsInPeriod.length > 0 ? (
          <ul className="mt-2 space-y-0.5 text-xs text-gray-600 dark:text-gray-400">
            {modelsInPeriod.map((row) => (
              <li key={`${row.provider ?? ''}/${row.model ?? ''}`} className="flex gap-2">
                <span className="min-w-0 truncate font-medium text-gray-700 dark:text-gray-300">
                  {modelLabel(row.provider, row.model)}
                </span>
                <span className="shrink-0 tabular-nums">
                  {number(row.input[bucket])} in
                  {row.cacheRead[bucket] > 0 ? ` (+${number(row.cacheRead[bucket])} cached)` : ''}
                  {' · '}
                  {number(row.output[bucket])} out
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No agents drafted yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3" aria-sort={sortKey === 'name' ? 'ascending' : 'none'}>
                  <button
                    type="button"
                    onClick={() => setSortKey('name')}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-gray-800 dark:hover:text-gray-200 ${
                      sortKey === 'name' ? 'text-gray-800 dark:text-gray-200' : ''
                    }`}
                    title="Sort by name"
                  >
                    Agent
                    {sortKey === 'name' ? <span aria-hidden="true">▴</span> : null}
                  </button>
                </th>
                <th className="py-2 pr-3">Owner</th>
                <th className="py-2 pr-3">State</th>
                <SortHeader column="runs" label={`Runs (${bucketLabel})`} />
                <SortHeader column="failures" label={`Failures (${bucketLabel})`} />
                <SortHeader column="tokensIn" label={`Tokens in (${bucketLabel})`} />
                <SortHeader column="tokensOut" label={`Tokens out (${bucketLabel})`} />
                <th className="py-2 pr-3">Last run</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {ordered.map((agent) => (
                <tr key={agent.id} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-2 pr-3">
                    <Link
                      href={`/${slug}/admin/agents/${agent.id}`}
                      className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {agent.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">
                    {agent.ownerEmail ?? agent.ownerSubject}
                  </td>
                  <td className="py-2 pr-3">{agent.enabled ? 'On' : 'Off'}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {number(runsByAgent[agent.id]?.[bucket] ?? 0)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {(failuresByAgent[agent.id]?.[bucket] ?? 0) > 0 ? (
                      <span className="font-medium text-red-600 dark:text-red-400">
                        {number(failuresByAgent[agent.id]?.[bucket] ?? 0)}
                      </span>
                    ) : (
                      '0'
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {number(tokensInByAgent[agent.id]?.[bucket] ?? 0)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {number(tokensOutByAgent[agent.id]?.[bucket] ?? 0)}
                  </td>
                  <td className="py-2 pr-3 text-gray-500">
                    {agent.lastRunAt ? <LocalTime at={agent.lastRunAt} /> : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {agent.enabled ? <AdminAgentActions slug={slug} agentId={agent.id} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
