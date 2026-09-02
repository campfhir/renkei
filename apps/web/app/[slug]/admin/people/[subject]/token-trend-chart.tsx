'use client';

/**
 * Token spend over time, for one person — all their agents summed by
 * default, or narrowed to one. The bucket width (day/week/month) is decided
 * by the period, not by the viewer, so the chart never asks anyone to make
 * sense of 365 slivers.
 */

import { useState, useTransition } from 'react';
import { getPersonTokenTrend, type PersonTrendReport } from './actions';
import { TREND_PERIODS, type TrendBucket } from './trend-window';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

/** Stacked bars, input below output — inline SVG for the same reason the tools page's is: one series, no dependency worth the import. */
function Chart({ points }: { points: TrendBucket[] }) {
  const peak = Math.max(1, ...points.map((point) => point.inputTokens + point.outputTokens));
  if (points.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">No token usage in this period.</p>
    );
  }
  return (
    <div>
      <div className="flex h-40 items-end gap-px" role="img" aria-label="Tokens over time">
        {points.map((point) => {
          const total = point.inputTokens + point.outputTokens;
          const height = (total / peak) * 100;
          const outShare = total > 0 ? (point.outputTokens / total) * height : 0;
          return (
            <div
              key={point.bucket}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={`${point.label}: ${formatTokens(point.inputTokens)} in, ${formatTokens(point.outputTokens)} out`}
            >
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col justify-end"
                style={{ height: '100%' }}
              >
                <div
                  className="w-full rounded-t-sm bg-purple-400 group-hover:bg-purple-300"
                  style={{ height: `${outShare}%` }}
                />
                <div
                  className="w-full bg-blue-500 group-hover:bg-blue-400"
                  style={{ height: `${height - outShare}%` }}
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
          <span className="h-2 w-2 rounded-sm bg-blue-500" /> Tokens in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-purple-400" /> Tokens out
        </span>
      </div>
    </div>
  );
}

export default function TokenTrendChart({
  tenantId,
  subject,
  agents,
  initial,
}: {
  tenantId: string;
  subject: string;
  agents: { id: string; name: string }[];
  initial: PersonTrendReport;
}) {
  const [report, setReport] = useState(initial);
  const [periodKey, setPeriodKey] = useState(initial.periodKey);
  const [agentId, setAgentId] = useState<string>('');
  const [pending, startTransition] = useTransition();

  function refresh(nextPeriod: string, nextAgentId: string) {
    startTransition(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next = await getPersonTokenTrend(
        tenantId,
        subject,
        nextPeriod,
        nextAgentId || null,
        timeZone
      );
      setReport(next);
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <nav className="flex flex-wrap items-center gap-1.5" aria-label="Period">
          {TREND_PERIODS.map((period) => (
            <button
              key={period.key}
              type="button"
              disabled={pending}
              onClick={() => {
                setPeriodKey(period.key);
                refresh(period.key, agentId);
              }}
              aria-pressed={periodKey === period.key}
              className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${
                periodKey === period.key
                  ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
              }`}
            >
              {period.label}
            </button>
          ))}
        </nav>
        {agents.length > 1 && (
          <select
            value={agentId}
            disabled={pending}
            onChange={(event) => {
              setAgentId(event.target.value);
              refresh(periodKey, event.target.value);
            }}
            className="ml-auto rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-950"
            aria-label="Break down by agent"
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        )}
        {pending && <span className="text-xs text-gray-500">Loading…</span>}
      </div>
      {report.error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{report.error}</p>
      ) : (
        <>
          <Chart points={report.points} />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Days in {report.timeZone}.
          </p>
        </>
      )}
    </div>
  );
}
