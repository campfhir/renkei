'use client';

/**
 * My usage: how much I am using, whether it is working, and what it costs.
 *
 * Three questions, in that order. The headline tiles answer the first at a
 * glance; the chart shows the shape over time for whichever series is
 * chosen (tokens, runs, tool calls — one chart, one toggle, so they share
 * an axis of time rather than each getting a strip of its own); the
 * attention list and the per-agent table answer the second and third,
 * each row linking to the agent's own page where the optimizer lives.
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { signInUrl } from '@/lib/sign-in-url';
import { getUtilizationReport, type UtilizationReport } from './actions';
import {
  UTILIZATION_PERIODS,
  failureKindLabel,
  formatTokens,
  tokensPerRun,
  type UtilizationBucket,
} from './window';

type Series = 'tokens' | 'runs' | 'tools';

const SERIES: { key: Series; label: string }[] = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'runs', label: 'Agent runs' },
  { key: 'tools', label: 'Tool calls' },
];

/**
 * Which two numbers a bar stacks, per series: the base in blue and the
 * highlight on top — output tokens (purple) or failures (red).
 */
function partsOf(bucket: UtilizationBucket, series: Series): { base: number; top: number } {
  switch (series) {
    case 'tokens':
      return { base: bucket.inputTokens, top: bucket.outputTokens };
    case 'runs':
      return { base: Math.max(0, bucket.runs - bucket.failures), top: bucket.failures };
    case 'tools':
      return { base: Math.max(0, bucket.toolCalls - bucket.toolErrors), top: bucket.toolErrors };
  }
}

function legendOf(series: Series): { base: string; top: string; topClass: string } {
  switch (series) {
    case 'tokens':
      return { base: 'Tokens in', top: 'Tokens out', topClass: 'bg-purple-400' };
    case 'runs':
      return { base: 'Succeeded', top: 'Failed', topClass: 'bg-red-500' };
    case 'tools':
      return { base: 'OK', top: 'Failed', topClass: 'bg-red-500' };
  }
}

function tooltipOf(bucket: UtilizationBucket, series: Series): string {
  switch (series) {
    case 'tokens':
      return `${bucket.label}: ${formatTokens(bucket.inputTokens)} in, ${formatTokens(bucket.outputTokens)} out`;
    case 'runs':
      return `${bucket.label}: ${bucket.runs} runs, ${bucket.failures} failed`;
    case 'tools':
      return `${bucket.label}: ${bucket.toolCalls} calls, ${bucket.toolErrors} failed`;
  }
}

/** Stacked bars — inline markup, one series at a time, no chart dependency. */
function Chart({ points, series }: { points: UtilizationBucket[]; series: Series }) {
  const legend = legendOf(series);
  const totals = points.map((point) => {
    const { base, top } = partsOf(point, series);
    return base + top;
  });
  const peak = Math.max(1, ...totals);
  if (points.length === 0 || totals.every((total) => total === 0)) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Nothing in this period.</p>;
  }
  return (
    <div>
      <div
        className="flex h-40 items-end gap-px"
        role="img"
        aria-label={`${legend.base} and ${legend.top} over time`}
      >
        {points.map((point) => {
          const { base, top } = partsOf(point, series);
          const total = base + top;
          const height = (total / peak) * 100;
          const topShare = total > 0 ? (top / total) * height : 0;
          return (
            <div
              key={point.bucket}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={tooltipOf(point, series)}
            >
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col justify-end"
                style={{ height: '100%' }}
              >
                <div
                  className={`w-full rounded-t-sm ${legend.topClass}`}
                  style={{ height: `${topShare}%` }}
                />
                <div
                  className="w-full bg-blue-500 group-hover:bg-blue-400"
                  style={{ height: `${height - topShare}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-blue-500" /> {legend.base}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-sm ${legend.topClass}`} /> {legend.top}
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-800">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export default function UtilizationViewer({
  slug,
  tenantId,
  initial,
}: {
  slug: string;
  tenantId: string;
  initial: UtilizationReport;
}) {
  const [report, setReport] = useState(initial);
  const [series, setSeries] = useState<Series>('tokens');
  const [pending, startTransition] = useTransition();

  function refresh(periodKey: string) {
    startTransition(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next = await getUtilizationReport(tenantId, periodKey, timeZone);
      if (next.signedOut) {
        window.location.href = signInUrl(tenantId, `/${slug}/utilization`);
        return;
      }
      setReport(next);
    });
  }

  const { totals } = report;
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const perRun = tokensPerRun(totals.inputTokens, totals.outputTokens, totals.runs);
  const failureRate = totals.runs > 0 ? (totals.failures / totals.runs) * 100 : 0;
  const toolErrorRate = totals.toolCalls > 0 ? (totals.toolErrors / totals.toolCalls) * 100 : 0;
  const periodLabel =
    UTILIZATION_PERIODS.find((period) => period.key === report.periodKey)?.label ??
    `${report.days} days`;

  return (
    <div className="flex flex-col gap-5" data-wide-page>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">My usage</h1>
        <Link
          href={`/${slug}/usage`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Tools
        </Link>
        <p className="w-full text-sm text-gray-500 dark:text-gray-400">
          Everything done as you: the tokens your agents spend, their runs, and every tool call made
          under your account — from a chat client or by an agent acting for you. Counts only, never
          content.
        </p>
      </header>

      {report.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {report.error}
        </p>
      )}

      <nav className="flex flex-wrap items-center gap-2" aria-label="Period">
        {UTILIZATION_PERIODS.map((period) => (
          <button
            key={period.key}
            type="button"
            disabled={pending}
            onClick={() => refresh(period.key)}
            aria-pressed={report.periodKey === period.key}
            className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 ${
              report.periodKey === period.key
                ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
            }`}
          >
            {period.label}
          </button>
        ))}
        {pending && <span className="text-sm text-gray-500">Loading…</span>}
      </nav>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Tokens"
          value={formatTokens(totalTokens)}
          hint={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`}
        />
        <Stat
          label="Agent runs"
          value={totals.runs.toLocaleString('en-US')}
          hint={
            totals.failures > 0
              ? `${totals.failures.toLocaleString('en-US')} failed (${failureRate.toFixed(0)}%)`
              : totals.runs > 0
                ? 'none failed'
                : undefined
          }
        />
        <Stat
          label="Tool calls"
          value={totals.toolCalls.toLocaleString('en-US')}
          hint={
            totals.toolErrors > 0
              ? `${totals.toolErrors.toLocaleString('en-US')} failed (${toolErrorRate.toFixed(1)}%)`
              : totals.toolCalls > 0
                ? 'none failed'
                : undefined
          }
        />
        <Stat
          label="Tokens per run"
          value={perRun > 0 ? formatTokens(perRun) : '—'}
          hint="Average across every run in the period"
        />
      </section>

      <figure className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <figcaption className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Over the last {periodLabel}
          </span>
          <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-700">
            {SERIES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setSeries(option.key)}
                aria-pressed={series === option.key}
                className={`px-3 py-1 text-xs ${
                  series === option.key
                    ? 'bg-blue-600 font-medium text-white'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                }`}
              >
                {option.label}
              </button>
            ))}
          </span>
        </figcaption>
        <Chart points={report.series} series={series} />
      </figure>

      {report.attention.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Needs attention
          </h2>
          <p className="mb-3 text-xs text-amber-800/80 dark:text-amber-300/80">
            The same agent stopping at the same step for the same kind of reason. Open the agent and
            run <span className="font-medium">Improve</span> to have your org&rsquo;s model look at
            why.
          </p>
          <ul className="space-y-2">
            {report.attention.map((signature) => (
              <li
                key={`${signature.agentId}:${signature.stepName}:${signature.errorKind}:${signature.outcomeCode}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
              >
                <Link
                  href={`/${slug}/agents/${signature.agentId}#improve`}
                  className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                >
                  {signature.agentName}
                </Link>
                <span className="text-amber-900 dark:text-amber-200">
                  {signature.stepName ? (
                    <>
                      stops at{' '}
                      <span className="font-medium">&ldquo;{signature.stepName}&rdquo;</span>,{' '}
                    </>
                  ) : null}
                  {failureKindLabel(signature.errorKind)}
                  {signature.outcomeCode ? (
                    <span className="ml-1 font-mono text-xs text-amber-800/80 dark:text-amber-300/80">
                      {signature.outcomeCode}
                    </span>
                  ) : null}
                </span>
                <span className="tabular-nums text-amber-800/80 dark:text-amber-300/80">
                  ×{signature.count}
                </span>
                <span className="text-xs text-amber-800/70 dark:text-amber-300/70">
                  last {new Date(signature.lastAt).toLocaleString()}
                </span>
                {signature.lastError ? (
                  <span
                    className="w-full truncate text-xs text-amber-900/80 dark:text-amber-200/80"
                    title={signature.lastError}
                  >
                    {signature.lastError}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          By agent
        </h2>
        {report.agents.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You have no agents yet.{' '}
            <Link href={`/${slug}/agents/new`} className="text-blue-600 hover:underline">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 text-right font-medium">Runs</th>
                  <th className="px-3 py-2 text-right font-medium">Failed</th>
                  <th className="px-3 py-2 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2 text-right font-medium">Per run</th>
                  <th className="px-3 py-2 font-medium">Last failure</th>
                  <th className="px-3 py-2 font-medium" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {report.agents.map((agent) => {
                  const tokens = agent.inputTokens + agent.outputTokens;
                  return (
                    <tr
                      key={agent.agentId}
                      className="border-t border-gray-200 dark:border-gray-800"
                    >
                      <td className="px-3 py-2">
                        <Link
                          href={`/${slug}/agents/${agent.agentId}`}
                          className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {agent.name}
                        </Link>
                        {!agent.enabled && (
                          <span className="ml-2 text-xs text-gray-400">(off)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {agent.runs.toLocaleString('en-US')}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {agent.failures > 0 ? (
                          <span className="text-red-600 dark:text-red-400">{agent.failures}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        title={`${agent.inputTokens.toLocaleString('en-US')} in, ${agent.outputTokens.toLocaleString('en-US')} out`}
                      >
                        {formatTokens(tokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {agent.runs > 0
                          ? formatTokens(
                              tokensPerRun(agent.inputTokens, agent.outputTokens, agent.runs)
                            )
                          : '—'}
                      </td>
                      <td className="max-w-xs truncate px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                        {agent.lastFailureAt ? (
                          <>
                            {agent.lastFailureStep ? `at “${agent.lastFailureStep}”, ` : ''}
                            {failureKindLabel(agent.lastFailureKind)} ·{' '}
                            {new Date(agent.lastFailureAt).toLocaleDateString()}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/${slug}/agents/${agent.agentId}#improve`}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Improve
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Runs and tokens are tallied by calendar day on the server; tool calls by your local day.
          At the edges of a day the two can differ by one.
        </p>
      </section>
    </div>
  );
}
