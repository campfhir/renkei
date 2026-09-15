'use client';

/**
 * Organization Usage: how much the org is spending, how much of it is
 * actually being used, and who and what is driving it. The tenant-wide
 * counterpart to "My usage" (utilization/utilization-viewer.tsx) — same
 * shape (period picker, headline tiles, one chart behind a series toggle),
 * plus the leaderboards a person's own page has no reason to show.
 */

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { getOrgUsageReport, type OrgUsageReport } from './actions';
import { ORG_USAGE_PERIODS, activeUserPercent, formatTokens, type OrgBucket } from './window';
import type { EfficientAgentRow, TopAgentRow, TopUserRow, OrgToolRow } from '@/lib/usage/org-usage';

type Series = 'tokens' | 'runs' | 'tools';

const SERIES: { key: Series; label: string }[] = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'runs', label: 'Agent runs' },
  { key: 'tools', label: 'Tool calls' },
];

const TOKEN_SEGMENTS: {
  key: 'chatTokens' | 'chatProjectTokens' | 'codeProjectTokens' | 'agentTokens';
  label: string;
  className: string;
}[] = [
  { key: 'chatTokens', label: 'Chat', className: 'bg-blue-500' },
  { key: 'chatProjectTokens', label: 'Chat projects', className: 'bg-teal-500' },
  { key: 'codeProjectTokens', label: 'Code projects', className: 'bg-amber-500' },
  { key: 'agentTokens', label: 'Agents', className: 'bg-purple-500' },
];

interface Segment {
  label: string;
  value: number;
  className: string;
}

function legendFor(series: Series): { label: string; className: string }[] {
  if (series === 'tokens') return TOKEN_SEGMENTS.map(({ label, className }) => ({ label, className }));
  if (series === 'runs')
    return [
      { label: 'Succeeded', className: 'bg-blue-500' },
      { label: 'Failed', className: 'bg-red-500' },
    ];
  return [
    { label: 'OK', className: 'bg-blue-500' },
    { label: 'Failed', className: 'bg-red-500' },
  ];
}

function segmentsOf(bucket: OrgBucket, series: Series): Segment[] {
  if (series === 'tokens') {
    return TOKEN_SEGMENTS.map((seg) => ({
      label: seg.label,
      value: bucket[seg.key],
      className: seg.className,
    }));
  }
  if (series === 'runs') {
    return [
      { label: 'Succeeded', value: Math.max(0, bucket.runs - bucket.failures), className: 'bg-blue-500' },
      { label: 'Failed', value: bucket.failures, className: 'bg-red-500' },
    ];
  }
  return [
    {
      label: 'OK',
      value: Math.max(0, bucket.toolCalls - bucket.toolErrors),
      className: 'bg-blue-500',
    },
    { label: 'Failed', value: bucket.toolErrors, className: 'bg-red-500' },
  ];
}

/**
 * Stacked bars, one series at a time, no chart dependency — the same
 * inline-CSS shape every usage surface in this app already uses. Segments
 * are drawn in reverse order (last first in the DOM) so `justify-end`
 * anchors the base of the stack to the bar's bottom and the first-listed
 * category ends up on top, which is where its rounded corner belongs.
 */
function Chart({ points, series }: { points: OrgBucket[]; series: Series }) {
  const legend = legendFor(series);
  const rows = points.map((point) => segmentsOf(point, series));
  const totals = rows.map((segments) => segments.reduce((sum, seg) => sum + seg.value, 0));
  const peak = Math.max(1, ...totals);
  if (points.length === 0 || totals.every((total) => total === 0)) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Nothing in this period.</p>;
  }
  return (
    <div>
      <div
        className="flex h-40 items-end gap-px"
        role="img"
        aria-label={`${legend.map((entry) => entry.label).join(', ')} over time`}
      >
        {points.map((point, index) => {
          const segments = rows[index]!;
          const total = totals[index]!;
          const height = (total / peak) * 100;
          const tooltip = `${point.label}: ${segments
            .filter((seg) => seg.value > 0)
            .map((seg) => `${seg.label} ${seg.value.toLocaleString('en-US')}`)
            .join(', ')}`;
          return (
            <div
              key={point.bucket}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={tooltip || point.label}
            >
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col justify-end"
                style={{ height: '100%' }}
              >
                {[...segments].reverse().map((seg, idx) => (
                  <div
                    key={seg.label}
                    className={`w-full ${seg.className} ${idx === 0 ? 'rounded-t-sm' : ''}`}
                    style={{ height: `${total > 0 ? (seg.value / total) * height : 0}%` }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        {legend.map((entry) => (
          <span key={entry.label} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-sm ${entry.className}`} /> {entry.label}
          </span>
        ))}
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

/** One row of the surface breakdown: its own tokens against the org total. */
function SurfaceRow({
  label,
  input,
  output,
  shareOfTotal,
  className,
}: {
  label: string;
  input: number;
  output: number;
  shareOfTotal: number;
  className: string;
}) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
          {formatTokens(input + output)}
          <span className="ml-1 text-xs text-gray-400">
            ({formatTokens(input)} in · {formatTokens(output)} out)
          </span>
        </span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
        aria-hidden="true"
      >
        <div className={`h-full rounded-full ${className}`} style={{ width: `${shareOfTotal}%` }} />
      </div>
    </li>
  );
}

/** A ranked list with a bar proportional to the leader — the shared leaderboard shape. */
function Leaderboard<Row>({
  heading,
  hint,
  rows,
  empty,
  keyOf,
  labelOf,
  valueOf,
  formatValue,
  barClassName = 'bg-blue-500',
}: {
  heading: string;
  hint: string;
  rows: Row[];
  empty: string;
  keyOf: (row: Row) => string;
  labelOf: (row: Row) => React.ReactNode;
  valueOf: (row: Row) => number;
  formatValue: (row: Row) => string;
  barClassName?: string;
}) {
  const largest = rows.reduce((max, row) => Math.max(max, valueOf(row)), 0);
  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-semibold">{heading}</h2>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => (
            <li key={keyOf(row)}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{labelOf(row)}</span>
                <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
                  {formatValue(row)}
                </span>
              </div>
              <div
                className="mt-1 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800"
                aria-hidden="true"
              >
                <div
                  className={`h-full rounded-full ${barClassName}`}
                  style={{ width: `${largest > 0 ? (valueOf(row) / largest) * 100 : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function OrgUsageViewer({
  slug,
  tenantId,
  initial,
}: {
  slug: string;
  tenantId: string;
  initial: OrgUsageReport;
}) {
  const [report, setReport] = useState(initial);
  const [series, setSeries] = useState<Series>('tokens');
  const [includeAgents, setIncludeAgents] = useState(initial.includeAgentsInTopUsers);
  const [pending, startTransition] = useTransition();

  function refresh(periodKey: string, nextIncludeAgents: boolean) {
    startTransition(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next = await getOrgUsageReport(tenantId, periodKey, timeZone, nextIncludeAgents);
      setReport(next);
    });
  }

  if (report.forbidden || report.signedOut) {
    return (
      <div className="mx-auto max-w-lg">
        <h2 className="mb-2 text-lg font-semibold">
          {report.signedOut ? 'Sign in required' : 'Operator access required'}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{report.error}</p>
      </div>
    );
  }

  const { tokens, activity } = report;
  const surfaceTotals = [tokens.chat, tokens.chatProjects, tokens.codeProjects, tokens.agents];
  const totalTokens = surfaceTotals.reduce((sum, surface) => sum + surface.input + surface.output, 0);
  const failureRate = activity.runs > 0 ? (activity.failures / activity.runs) * 100 : 0;
  const toolErrorRate = activity.toolCalls > 0 ? (activity.toolErrors / activity.toolCalls) * 100 : 0;
  const activePct = activeUserPercent(activity.activeUsers, activity.totalUsers);
  const periodLabel =
    ORG_USAGE_PERIODS.find((period) => period.key === report.periodKey)?.label ??
    `${report.days} days`;

  const shareOf = (surface: { input: number; output: number }) =>
    totalTokens > 0 ? ((surface.input + surface.output) / totalTokens) * 100 : 0;

  return (
    <div className="flex flex-col gap-5" data-wide-page>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">Organization usage</h1>
        <Link
          href={`/${slug}/admin`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Organization
        </Link>
        <p className="w-full text-sm text-gray-500 dark:text-gray-400">
          Every surface&rsquo;s token spend across the tenant — chat, chat projects, code projects
          and agents — how much of the org is actually using it, and who and what is driving the
          bill. Counts only, never content.
        </p>
      </header>

      {report.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {report.error}
        </p>
      )}

      <nav className="flex flex-wrap items-center gap-2" aria-label="Period">
        {ORG_USAGE_PERIODS.map((period) => (
          <button
            key={period.key}
            type="button"
            disabled={pending}
            onClick={() => refresh(period.key, includeAgents)}
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
          hint={`${formatTokens(tokens.agents.input + tokens.agents.output)} in agents`}
        />
        <Stat
          label="Active users"
          value={`${activity.activeUsers.toLocaleString('en-US')} / ${activity.totalUsers.toLocaleString('en-US')}`}
          hint={`${activePct}% used at least one token`}
        />
        <Stat
          label="Agent runs"
          value={activity.runs.toLocaleString('en-US')}
          hint={
            activity.failures > 0
              ? `${activity.failures.toLocaleString('en-US')} failed (${failureRate.toFixed(0)}%)`
              : activity.runs > 0
                ? 'none failed'
                : undefined
          }
        />
        <Stat
          label="Tool calls"
          value={activity.toolCalls.toLocaleString('en-US')}
          hint={
            activity.toolErrors > 0
              ? `${activity.toolErrors.toLocaleString('en-US')} failed (${toolErrorRate.toFixed(1)}%)`
              : activity.toolCalls > 0
                ? 'none failed'
                : undefined
          }
        />
      </section>

      <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
        <h2 className="mb-3 text-sm font-semibold">Tokens by surface</h2>
        <ul className="space-y-3">
          <SurfaceRow
            label="Chat"
            input={tokens.chat.input}
            output={tokens.chat.output}
            shareOfTotal={shareOf(tokens.chat)}
            className="bg-blue-500"
          />
          <SurfaceRow
            label="Chat projects"
            input={tokens.chatProjects.input}
            output={tokens.chatProjects.output}
            shareOfTotal={shareOf(tokens.chatProjects)}
            className="bg-teal-500"
          />
          <SurfaceRow
            label="Code projects"
            input={tokens.codeProjects.input}
            output={tokens.codeProjects.output}
            shareOfTotal={shareOf(tokens.codeProjects)}
            className="bg-amber-500"
          />
          <SurfaceRow
            label="Agents"
            input={tokens.agents.input}
            output={tokens.agents.output}
            shareOfTotal={shareOf(tokens.agents)}
            className="bg-purple-500"
          />
        </ul>
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

      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Top users
            </h2>
            <span className="inline-flex overflow-hidden rounded-lg border border-gray-300 text-xs dark:border-gray-700">
              {(
                [
                  { key: false, label: 'Chats only' },
                  { key: true, label: '+ agents' },
                ] as const
              ).map((option) => (
                <button
                  key={String(option.key)}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setIncludeAgents(option.key);
                    refresh(report.periodKey, option.key);
                  }}
                  aria-pressed={includeAgents === option.key}
                  className={`px-2 py-1 disabled:opacity-50 ${
                    includeAgents === option.key
                      ? 'bg-blue-600 font-medium text-white'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>
          <Leaderboard<TopUserRow>
            heading="By tokens spent"
            hint={
              includeAgents
                ? 'Chat, chat-project, code-project and agent tokens combined.'
                : 'Chat, chat-project and code-project tokens — toggle above to fold in their agents.'
            }
            rows={report.topUsers}
            empty="Nobody has spent any tokens in this period."
            keyOf={(row) => row.subject}
            labelOf={(row) => row.label}
            valueOf={(row) => row.totalTokens}
            formatValue={(row) => formatTokens(row.totalTokens)}
          />
        </div>

        <Leaderboard<TopAgentRow>
          heading="Top agents"
          hint="By total tokens spent over the period."
          rows={report.topAgents}
          empty="No agent has run in this period."
          keyOf={(row) => row.agentId}
          labelOf={(row) => (
            <Link
              href={`/${slug}/admin/agents/${row.agentId}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {row.name}
            </Link>
          )}
          valueOf={(row) => row.inputTokens + row.outputTokens}
          formatValue={(row) => formatTokens(row.inputTokens + row.outputTokens)}
        />

        <Leaderboard<EfficientAgentRow>
          heading="Most efficient agents"
          hint="Tool calls per 1,000 tokens, among succeeded runs — real work per token, not just cheap runs."
          rows={report.efficientAgents}
          empty="No agent has 3 or more succeeded runs in this period yet."
          keyOf={(row) => row.agentId}
          labelOf={(row) => (
            <Link
              href={`/${slug}/admin/agents/${row.agentId}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              {row.name}
            </Link>
          )}
          valueOf={(row) => row.efficiency}
          formatValue={(row) => `${row.efficiency.toFixed(1)} / 1k · ${formatTokens(row.tokensPerRun)}/run`}
          barClassName="bg-emerald-500"
        />
      </div>

      <Leaderboard<OrgToolRow>
        heading="Top tools"
        hint="Most-called tools across the whole organization over the period."
        rows={report.topTools}
        empty="No tool has been called in this period."
        keyOf={(row) => row.tool}
        labelOf={(row) => row.tool}
        valueOf={(row) => row.calls}
        formatValue={(row) =>
          row.errors > 0
            ? `${row.calls.toLocaleString('en-US')} (${row.errors.toLocaleString('en-US')} failed)`
            : row.calls.toLocaleString('en-US')
        }
      />

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Days are calendar days in {report.timeZone}. &ldquo;Active users&rdquo; counts anyone who
        spent at least one token — in a chat, a project, or an agent run — during the period,
        against everyone who has ever signed in to this organization.
      </p>
    </div>
  );
}
