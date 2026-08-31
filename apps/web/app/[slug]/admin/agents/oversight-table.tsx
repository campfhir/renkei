'use client';

/**
 * The oversight list with its run tallies, one PERIOD at a time: a single
 * toggle (today … all-time) drives the org-wide total, the per-agent Runs
 * column AND the Failures column, instead of six number columns shouting
 * at once. Client component purely for that toggle — the data all arrives
 * from the server page, pre-bucketed.
 */

import { useState } from 'react';
import Link from 'next/link';
import LocalTime from '@/components/local-time';
import type { AdminAgentRow } from '@/lib/agents/runs-view';
import { AdminAgentActions } from './admin-agent-actions';

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

export default function OversightTable({
  slug,
  agents,
  runsByAgent,
  failuresByAgent,
  totals,
  failureTotals,
  dailyCap,
}: {
  slug: string;
  agents: AdminAgentRow[];
  runsByAgent: Record<string, RunBuckets>;
  failuresByAgent: Record<string, RunBuckets>;
  totals: RunBuckets;
  failureTotals: RunBuckets;
  dailyCap: number | null;
}): React.ReactNode {
  const [bucket, setBucket] = useState<keyof RunBuckets>('today');
  const bucketLabel = BUCKETS.find((option) => option.key === bucket)?.label.toLowerCase();

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
          {totals[bucket].toLocaleString('en-US')}
          <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
            run{totals[bucket] === 1 ? '' : 's'} across all agents
            {failureTotals[bucket] > 0 ? (
              <>
                {' · '}
                <span className="font-medium text-red-600 dark:text-red-400">
                  {failureTotals[bucket].toLocaleString('en-US')} failed
                </span>
              </>
            ) : null}
            {bucket === 'today' && dailyCap !== null
              ? ` — of the ${dailyCap.toLocaleString('en-US')}-per-day cap`
              : ''}
          </span>
        </p>
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No agents drafted yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3">Owner</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3 text-right">Runs ({bucketLabel})</th>
                <th className="py-2 pr-3 text-right">Failures ({bucketLabel})</th>
                <th className="py-2 pr-3">Last run</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
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
                    {(runsByAgent[agent.id]?.[bucket] ?? 0).toLocaleString('en-US')}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {(failuresByAgent[agent.id]?.[bucket] ?? 0) > 0 ? (
                      <span className="font-medium text-red-600 dark:text-red-400">
                        {(failuresByAgent[agent.id]?.[bucket] ?? 0).toLocaleString('en-US')}
                      </span>
                    ) : (
                      '0'
                    )}
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
