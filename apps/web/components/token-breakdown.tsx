'use client';

/**
 * Where an agent's tokens went: by model, and by step and model — one
 * period at a time behind the same today … all-time toggle the oversight
 * page uses, because six periods times two tables is a wall of numbers
 * nobody reads. Client component purely for that toggle; the rows arrive
 * pre-bucketed from `lib/agents/agent-usage.ts`.
 *
 * The by-model split is what turns a token count into something a cost
 * can be read against; the by-step split is where the spend is coming
 * from inside the agent, so the expensive step can be found without
 * opening runs one by one.
 */

import { useState } from 'react';
import type {
  UsageBuckets,
  TokenUsage,
  ModelTokenUsage,
  StepTokenUsage,
} from '@/lib/agents/agent-usage';
import { modelLabel } from '@/lib/agents/model-label';

const BUCKETS: { key: keyof UsageBuckets; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'allTime', label: 'All time' },
];

function stepLabel(row: StepTokenUsage): string {
  if (row.stepId === null) return 'Outside any step (optimizer)';
  return row.stepName ?? 'A step since removed';
}

const number = (value: number) => value.toLocaleString('en-US');

export default function TokenBreakdown({
  byModel,
  bySteps,
  defaultBucket = 'month',
}: {
  byModel: ModelTokenUsage[];
  /** Absent when the panel sums several agents — steps only mean something for one. */
  bySteps?: StepTokenUsage[];
  defaultBucket?: keyof UsageBuckets;
}): React.ReactNode {
  const [bucket, setBucket] = useState<keyof UsageBuckets>(defaultBucket);
  const spent = (row: TokenUsage) =>
    row.input[bucket] + row.output[bucket] + row.cacheRead[bucket] + row.cacheWrite[bucket];
  const inPeriod = <T extends TokenUsage>(rows: T[]) =>
    rows.filter((row) => spent(row) > 0).sort((a, b) => spent(b) - spent(a));
  const models = inPeriod(byModel);
  const steps = bySteps ? inPeriod(bySteps) : null;
  // The cache columns only earn their width when something was cached.
  const showCache = [...models, ...(steps ?? [])].some(
    (row) => row.cacheRead[bucket] + row.cacheWrite[bucket] > 0
  );
  const headerClass = 'pb-1 pr-3 text-right font-medium';
  const cacheHeaders = showCache ? (
    <>
      <th className={headerClass} title="Prompt tokens served from the provider's cache">
        Cached in
      </th>
      <th className={headerClass} title="Prompt tokens written to the provider's cache">
        Cache writes
      </th>
    </>
  ) : null;
  const cacheCells = (row: TokenUsage) =>
    showCache ? (
      <>
        <td className="pr-3 text-right tabular-nums">{number(row.cacheRead[bucket])}</td>
        <td className="pr-3 text-right tabular-nums">{number(row.cacheWrite[bucket])}</td>
      </>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Where the tokens went
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

      <div>
        <p className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">By model</p>
        {models.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No tokens in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th className="pb-1 pr-3 font-medium">Model</th>
                  <th className={headerClass}>Tokens in</th>
                  {cacheHeaders}
                  <th className={headerClass}>Tokens out</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <tr key={`${row.provider ?? ''}/${row.model ?? ''}`}>
                    <td className="whitespace-nowrap pr-3">
                      {modelLabel(row.provider, row.model)}
                    </td>
                    <td className="pr-3 text-right tabular-nums">{number(row.input[bucket])}</td>
                    {cacheCells(row)}
                    <td className="pr-3 text-right tabular-nums">{number(row.output[bucket])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {steps ? (
        <div>
          <p className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">By step</p>
          {steps.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No tokens in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <th className="pb-1 pr-3 font-medium">Step</th>
                    <th className="pb-1 pr-3 font-medium">Model</th>
                    <th className={headerClass} title="Attempts that reached the model">
                      Calls
                    </th>
                    <th className={headerClass}>Tokens in</th>
                    {cacheHeaders}
                    <th className={headerClass}>Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((row) => (
                    <tr key={`${row.stepId ?? ''}/${row.provider ?? ''}/${row.model ?? ''}`}>
                      <td
                        className={`pr-3 ${row.stepName === null ? 'italic text-gray-500 dark:text-gray-400' : ''}`}
                      >
                        {stepLabel(row)}
                      </td>
                      <td className="pr-3 text-gray-600 dark:text-gray-400">
                        {modelLabel(row.provider, row.model)}
                      </td>
                      <td className="pr-3 text-right tabular-nums">{number(row.calls[bucket])}</td>
                      <td className="pr-3 text-right tabular-nums">{number(row.input[bucket])}</td>
                      {cacheCells(row)}
                      <td className="pr-3 text-right tabular-nums">{number(row.output[bucket])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
