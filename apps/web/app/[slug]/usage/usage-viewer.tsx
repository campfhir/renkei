'use client';

/**
 * Tool usage: what you have, what you use, and how it is behaving.
 *
 * Three questions, in the order people ask them. How much am I using this?
 * (totals and the trend). Which tools, and are any of them slow or failing?
 * (the per-tool table). And for an operator, who is using it? (the per-person
 * table, which only they receive — see `actions.ts`).
 *
 * Tools with no calls are listed rather than hidden. A usage page that only
 * showed what had been used could never answer "what else can I do", which is
 * half of why someone opens it.
 */

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import ConnectorIcon from '@/components/connector-icon';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { signInUrl } from '@/lib/sign-in-url';
import {
  getUsageReport,
  getToolDetail,
  type UsageReport,
  type ToolUsageRow,
  type ToolDetail,
} from './actions';
import { friendlyToolName } from '@/lib/tool-name';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';

const PERIODS = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

/** Catalog label for a capability key, falling back to the key itself. */
function connectorLabel(key: string | null): string {
  if (!key) return 'Other';
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

interface Row {
  name: string;
  connector: string | null;
  kind: 'read' | 'act' | null;
  title: string | null;
  description: string | null;
  calls: number;
  errors: number;
  medianMs: number;
  p95Ms: number;
  /** Called, but not in this caller's own tool set — only seen org-wide. */
  foreign: boolean;
}

/**
 * The tool list, joined to its usage.
 *
 * Union rather than either side alone: the catalog holds tools nobody has
 * called yet, and tenant-wide usage holds tools this operator does not
 * personally have but someone else does. Dropping either would misreport.
 */
function joinRows(tools: ToolDescriptor[], usage: ToolUsageRow[]): Row[] {
  const byName = new Map<string, Row>();
  for (const tool of tools) {
    byName.set(tool.name, {
      name: tool.name,
      connector: tool.connector,
      kind: tool.kind,
      title: tool.title,
      description: tool.description,
      calls: 0,
      errors: 0,
      medianMs: 0,
      p95Ms: 0,
      foreign: false,
    });
  }
  for (const row of usage) {
    const existing = byName.get(row.tool);
    if (existing) {
      existing.calls = row.calls;
      existing.errors = row.errors;
      existing.medianMs = row.medianMs;
      existing.p95Ms = row.p95Ms;
    } else {
      byName.set(row.tool, {
        name: row.tool,
        connector: row.connector,
        kind: null,
        title: null,
        description: null,
        calls: row.calls,
        errors: row.errors,
        medianMs: row.medianMs,
        p95Ms: row.p95Ms,
        foreign: true,
      });
    }
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function formatMs(ms: number): string {
  if (ms <= 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Daily calls as stacked bars, errors in red on top of successes.
 *
 * Inline SVG rather than a charting dependency: it is one series with a
 * highlight, and the whole thing is fewer lines than the import would be.
 */
function TrendChart({ points }: { points: UsageReport['trend'] }) {
  const peak = Math.max(1, ...points.map((point) => point.calls));
  if (points.length === 0) return null;

  return (
    <figure className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <figcaption className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
        Calls per day
        <span className="ml-2 font-normal text-gray-500">peak {peak}</span>
      </figcaption>
      <div className="flex h-32 items-end gap-px" role="img" aria-label="Daily tool calls">
        {points.map((point) => {
          const height = (point.calls / peak) * 100;
          const errorShare = point.calls > 0 ? (point.errors / point.calls) * height : 0;
          return (
            <div
              key={point.day}
              className="group relative flex-1"
              style={{ height: '100%' }}
              title={`${point.day}: ${point.calls} calls, ${point.errors} failed`}
            >
              <div
                className="absolute inset-x-0 bottom-0 flex flex-col justify-end"
                style={{ height: '100%' }}
              >
                <div
                  className="w-full rounded-t-sm bg-red-500"
                  style={{ height: `${errorShare}%` }}
                />
                <div
                  className="w-full bg-blue-500 group-hover:bg-blue-400"
                  style={{ height: `${height - errorShare}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{points[0]?.day}</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </figure>
  );
}

/**
 * One tool: what it is called, how often it ran, and how it went.
 *
 * The identifier is kept on the title attribute rather than on the face of the
 * card — someone debugging a tool call wants `confluence_update_blogpost`, and
 * everyone else wants "Edit a blog post". A tool nobody has called is shown
 * greyed rather than hidden, because "what else can I do" is half the question
 * this page answers.
 */
function ToolCard({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const used = row.calls > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={row.name}
      className={`flex min-h-[5.5rem] flex-col justify-between rounded-lg border p-3 text-left hover:border-blue-400 hover:shadow-sm dark:hover:border-blue-600 ${
        used
          ? 'border-gray-200 dark:border-gray-800'
          : 'border-dashed border-gray-200 dark:border-gray-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Wraps within the fixed card width; the count never wraps away. */}
        <span
          className={`text-sm font-medium leading-snug ${used ? '' : 'text-gray-400 dark:text-gray-600'}`}
        >
          {friendlyToolName(row.name, row.title)}
        </span>
        <span
          className={`shrink-0 text-lg font-semibold tabular-nums ${
            used ? '' : 'text-gray-300 dark:text-gray-700'
          }`}
        >
          {used ? row.calls.toLocaleString() : '—'}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {used ? (
          <>
            <span className="text-gray-600 dark:text-gray-400">
              {(row.calls - row.errors).toLocaleString()} ok
            </span>
            {row.errors > 0 ? (
              <span className="text-red-600 dark:text-red-400">
                {row.errors.toLocaleString()} failed
              </span>
            ) : null}
            {row.p95Ms > 0 && (
              <span className="text-gray-500" title="95th percentile — the slow calls">
                p95 {formatMs(row.p95Ms)}
              </span>
            )}
          </>
        ) : (
          <span className="text-gray-400 dark:text-gray-600">Not used yet</span>
        )}
        {row.kind === 'act' && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            act
          </span>
        )}
        {row.foreign && (
          <span
            className="text-[10px] uppercase text-gray-500"
            title="Called by someone else in this tenant; not in your own tool set"
          >
            other account
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * One tool up close, on top of the page rather than a page of its own.
 *
 * The failure list shows when, how long, and (tenant-wide) whose call — never
 * arguments or error text, because usage telemetry stores none (the tools'
 * own responses carry their error messages; this page carries the pattern).
 * Saying that on the panel stops the reader hunting for a detail level that
 * deliberately does not exist.
 */
function ToolDetailDialog({
  row,
  tenantId,
  days,
  scope,
  onClose,
}: {
  row: Row;
  tenantId: string;
  days: number;
  scope: 'self' | 'tenant';
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ToolDetail | null>(null);

  useEffect(() => {
    let stale = false;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    getToolDetail(tenantId, row.name, days, timeZone, scope).then((fetched) => {
      if (!stale) setDetail(fetched);
    });
    return () => {
      stale = true;
    };
  }, [tenantId, row.name, days, scope]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stats = detail ?? row;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={friendlyToolName(row.name, row.title)}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold">{friendlyToolName(row.name, row.title)}</h3>
            <p className="font-mono text-xs text-gray-500">{row.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>

        {row.description && (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{row.description}</p>
        )}

        <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
          {(
            [
              ['Calls', stats.calls.toLocaleString()],
              ['Failed', stats.errors.toLocaleString()],
              ['Median', formatMs(stats.medianMs)],
              ['p95', formatMs(stats.p95Ms)],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-gray-200 px-2 py-2 dark:border-gray-800"
            >
              <dt className="text-[10px] uppercase tracking-wide text-gray-500">{label}</dt>
              <dd className="text-sm font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        {!detail && <p className="mt-4 text-sm text-gray-500">Loading…</p>}
        {detail?.error && (
          <p className="mt-4 text-sm text-red-600 dark:text-red-400">{detail.error}</p>
        )}

        {detail && !detail.error && (
          <div className="mt-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Recent failures
            </h4>
            {detail.failures.length === 0 ? (
              <p className="text-sm text-gray-500">
                No failed calls in the last {detail.days === 1 ? '24 hours' : `${detail.days} days`}
                .
              </p>
            ) : (
              <>
                <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 text-sm dark:divide-gray-900 dark:border-gray-800">
                  {detail.failures.map((failure) => (
                    <li key={failure.at + (failure.by ?? '')} className="px-3 py-1.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="tabular-nums">
                          {new Date(failure.at).toLocaleString()}
                        </span>
                        <span className="flex items-baseline gap-3 text-gray-500">
                          {failure.by && <span className="truncate">{failure.by}</span>}
                          <span className="tabular-nums">{formatMs(failure.durationMs)}</span>
                        </span>
                      </div>
                      {failure.summary && (
                        <p className="mt-0.5 break-words text-xs text-red-700 dark:text-red-400">
                          {failure.summary}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-gray-500">
                  {detail.scope === 'tenant'
                    ? 'Error messages appear only on your own calls — each person sees theirs, to quote when asking for help. Arguments are never recorded.'
                    : 'Quote the error message when reporting a problem. Only you can see it; arguments are never recorded.'}
                </p>
              </>
            )}
          </div>
        )}
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

export default function UsageViewer({
  slug,
  tenantId,
  initial,
  tools,
}: {
  slug: string;
  tenantId: string;
  initial: UsageReport;
  tools: ToolDescriptor[];
}) {
  const [report, setReport] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Row | null>(null);

  function refresh(days: number, scope: 'self' | 'tenant') {
    startTransition(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setReport(await getUsageReport(tenantId, days, timeZone, scope));
    });
  }

  const rows = joinRows(tools, report.tools);
  const used = rows.filter((row) => row.calls > 0);
  // The slowest thing anyone actually waits on, which is the latency question
  // worth putting on the page.
  const slowest = [...used].sort((a, b) => b.p95Ms - a.p95Ms)[0];
  const errorRate = report.totalCalls > 0 ? (report.totalErrors / report.totalCalls) * 100 : 0;

  const byConnector = new Map<string, Row[]>();
  for (const row of rows) {
    const key = connectorLabel(row.connector);
    const list = byConnector.get(key);
    if (list) list.push(row);
    else byConnector.set(key, [row]);
  }
  const groups = [...byConnector.entries()].sort(
    (a, b) =>
      b[1].reduce((sum, row) => sum + row.calls, 0) -
        a[1].reduce((sum, row) => sum + row.calls, 0) || a[0].localeCompare(b[0])
  );

  return (
    <div className="flex flex-col gap-5" data-wide-page>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">Tools</h1>
        <Link
          href={`/${slug}/connectors`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Connectors
        </Link>
        <p className="w-full text-sm text-gray-500 dark:text-gray-400">
          {report.scope === 'tenant'
            ? 'Every account in this tenant. Tool names and counts only — never arguments or results.'
            : 'Your own tool calls. Counts and timings only — never arguments or results.'}
        </p>
      </header>

      {report.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {report.error}
          {report.signedOut && (
            <>
              {' '}
              <a className="font-medium underline" href={signInUrl(tenantId, `/${slug}/usage`)}>
                Sign in again
              </a>
            </>
          )}
        </p>
      )}

      <nav className="flex flex-wrap items-center gap-2" aria-label="Period">
        {PERIODS.map((period) => (
          <button
            key={period.days}
            type="button"
            disabled={pending}
            onClick={() => refresh(period.days, report.scope)}
            aria-pressed={report.days === period.days}
            className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 ${
              report.days === period.days
                ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900'
            }`}
          >
            {period.label}
          </button>
        ))}
        {report.canSeeTenant && (
          <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-700">
            {(['self', 'tenant'] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={pending}
                onClick={() => refresh(report.days, option)}
                aria-pressed={report.scope === option}
                className={`px-3 py-1.5 text-sm disabled:opacity-50 ${
                  report.scope === option
                    ? 'bg-blue-600 font-medium text-white'
                    : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                }`}
              >
                {option === 'self' ? 'Just me' : 'Everyone'}
              </button>
            ))}
          </span>
        )}
        {pending && <span className="text-sm text-gray-500">Loading…</span>}
      </nav>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Calls" value={report.totalCalls.toLocaleString()} />
        <Stat
          label="Failed"
          value={report.totalErrors.toLocaleString()}
          hint={report.totalCalls > 0 ? `${errorRate.toFixed(1)}% of calls` : undefined}
        />
        <Stat label="Tools used" value={`${used.length} of ${rows.length}`} />
        <Stat
          label="Slowest (p95)"
          value={slowest ? formatMs(slowest.p95Ms) : '—'}
          hint={slowest ? friendlyToolName(slowest.name, slowest.title) : undefined}
        />
      </section>

      <TrendChart points={report.trend} />

      {report.scope === 'tenant' && report.byUser.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
            By person
          </h2>
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 text-right font-medium">Calls</th>
                  <th className="px-3 py-2 text-right font-medium">Failed</th>
                </tr>
              </thead>
              <tbody>
                {report.byUser.map((user) => (
                  <tr
                    key={user.subject ?? user.label}
                    className="border-t border-gray-200 dark:border-gray-800"
                  >
                    <td className="px-3 py-2">{user.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {user.calls.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {user.errors > 0 ? (
                        <span className="text-red-600 dark:text-red-400">{user.errors}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {groups.length > 1 && (
        <nav
          aria-label="Jump to connector"
          className="sticky top-14 z-20 -mx-2 flex gap-1.5 overflow-x-auto border-b border-gray-200 bg-white px-2 py-2 dark:border-gray-800 dark:bg-black"
        >
          {groups.map(([label, groupRows]) => {
            const key = groupRows[0]?.connector;
            return (
              <button
                key={label}
                type="button"
                onClick={() =>
                  document
                    .getElementById(`connector-${label.replace(/[^A-Za-z0-9]+/g, '-')}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
              >
                {key && <ConnectorIcon capabilityKey={key} label={label} size={14} />}
                {label}
              </button>
            );
          })}
        </nav>
      )}

      <section className="flex flex-col">
        {rows.length === 0 && (
          <p className="text-sm text-gray-500">
            No tools yet — connect an account on the{' '}
            <Link href={`/${slug}/connectors`} className="text-blue-600 hover:underline">
              connectors page
            </Link>
            .
          </p>
        )}

        {groups.map(([label, groupRows]) => {
          const key = groupRows[0]?.connector;
          const groupCalls = groupRows.reduce((sum, row) => sum + row.calls, 0);
          return (
            <div
              key={label}
              id={`connector-${label.replace(/[^A-Za-z0-9]+/g, '-')}`}
              className="scroll-mt-[6.5rem]"
            >
              {/*
                Each heading sticks to the same offset, so as a group scrolls
                past, the next heading arrives at the top and carries the
                previous one out of view — one connector named at the top at
                all times. The offset clears the app bar plus the jump nav
                (which only exists with 2+ groups); the opaque background is
                what stops cards showing through as they pass under.
              */}
              <h2
                className={`sticky ${groups.length > 1 ? 'top-[6.1rem]' : 'top-14'} z-10 -mx-2 mb-3 flex items-baseline gap-3 border-b border-gray-200 bg-white px-2 py-2 dark:border-gray-800 dark:bg-black`}
              >
                {key && <ConnectorIcon capabilityKey={key} label={label} size={18} />}
                <span className="font-semibold">{label}</span>
                <span className="text-sm font-normal text-gray-500">
                  {groupCalls.toLocaleString()} {groupCalls === 1 ? 'call' : 'calls'}
                </span>
              </h2>

              {/*
                A fixed card width rather than one column per tool: tool names
                are a known, narrow range of lengths, so a uniform card sized
                for two lines of name keeps the grid even and lets the row
                count do the talking. Names wrap inside that width instead of
                stretching it.
              */}
              <div className="mb-8 grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-3">
                {groupRows.map((row) => (
                  <ToolCard key={row.name} row={row} onOpen={() => setSelected(row)} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {selected && (
        <ToolDetailDialog
          row={selected}
          tenantId={tenantId}
          days={report.days}
          scope={report.scope}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
