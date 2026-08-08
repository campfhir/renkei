'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import type { FilterExpr, LogRow } from '@campfhir/bored-logs';
import {
  LogCard,
  LogDateRangePicker,
  LogLevelFilter,
  LogSearchBar,
  LogSearchSyntaxHelp,
  LogTable,
  LogTableRowGroup,
  type ExtraColumn,
  type LogDateRange,
  type SortState,
} from '@campfhir/bored-logs/components';
import { signInUrl } from '@/lib/sign-in-url';
import { searchLogs, type LogSearchResult } from './actions';
import { describeWindow, DEFAULT_WINDOW_DAYS, type LogWindow } from './window';

/** The levels this gateway actually writes, in severity order. */
const LEVELS = ['debug', 'info', 'warn', 'error', 'critical'];
const PAGE_SIZE = 25;

function StatusBadge({ value }: { value: unknown }) {
  const code = Number(value);
  if (!Number.isFinite(code)) return <span className="text-slate-400">—</span>;
  const tone =
    code >= 500
      ? 'bg-red-500/15 text-red-700 dark:text-red-300'
      : code >= 400
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${tone}`}>{code}</span>
  );
}

/** Extra columns beyond the built-in timestamp/level/message, read from `meta`. */
const COLUMNS: ExtraColumn[] = [
  { key: 'displayName', label: 'User' },
  { key: 'status', label: 'Status', render: (value) => <StatusBadge value={value} /> },
];

export default function LogsViewer({
  slug,
  tenantId,
  accountId,
  initial,
  initialWindow,
}: {
  slug: string;
  tenantId: string;
  accountId: string | null;
  initial: LogSearchResult;
  /** The window the server already searched, so the picker shows it. */
  initialWindow: LogWindow;
}) {
  const [{ logs, scope, error, signedOut }, setResult] = useState(initial);
  const [expr, setExpr] = useState<FilterExpr | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  // Seeded from what the server searched rather than empty. An empty picker
  // above a query scoped to a hidden window is how "no logs" got reported for a
  // tenant whose activity was simply older than that window.
  const [range, setRange] = useState<LogDateRange>(initialWindow);
  const [sort, setSort] = useState<SortState>({ column: 'timestamp', direction: 'desc' });
  const [page, setPage] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [pending, startTransition] = useTransition();

  // State updates are not readable until the next render, so whichever control
  // changed passes its new value in rather than relying on the state it just set.
  function refresh(next: {
    expr?: FilterExpr | null;
    levels?: string[];
    range?: LogDateRange;
    sort?: SortState;
  }) {
    const query = { expr, levels, range, sort, ...next };
    startTransition(async () => {
      setResult(
        await searchLogs(tenantId, {
          expr: query.expr,
          levels: query.levels,
          start: query.range.start,
          end: query.range.end,
          sort: query.sort.direction,
          accountId,
        })
      );
      setPage(1);
    });
  }

  // Timestamp order comes from the query itself, since the row limit is applied
  // server-side. Any other column can only reorder what was returned.
  const ordered = useMemo(() => {
    if (sort.column === 'timestamp') return logs;
    const direction = sort.direction === 'asc' ? 1 : -1;
    const cell = (log: LogRow) =>
      sort.column === 'level'
        ? log.level
        : sort.column === 'message'
          ? log.message
          : log.meta[sort.column];
    return [...logs].sort(
      (a, b) =>
        String(cell(a) ?? '').localeCompare(String(cell(b) ?? ''), undefined, { numeric: true }) *
        direction
    );
  }, [logs, sort]);

  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const pageLogs = ordered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  function onSortChange(next: SortState) {
    setSort(next);
    if (next.column === 'timestamp') refresh({ sort: next });
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold">Activity</h1>
        <Link
          href={`/${slug}/connectors`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Connectors
        </Link>
        <p className="w-full text-sm text-slate-500 dark:text-slate-400">
          {scope?.accountId ? (
            <>
              Jira account <code>{scope.accountId}</code>
            </>
          ) : scope?.role === 'renkei-operator' ? (
            'Every account in this tenant'
          ) : (
            ' '
          )}
        </p>
      </header>

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {error}
          {/* A session can expire while this page sits open. Offer the way back
              rather than leaving a filter change silently failing. */}
          {signedOut && (
            <>
              {' '}
              <a className="font-medium underline" href={signInUrl(tenantId, `/${slug}/logs`)}>
                Sign in again
              </a>
            </>
          )}
        </p>
      )}

      <section className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="log-levels">
          <LogLevelFilter
            levels={LEVELS}
            value={levels}
            onChange={(next) => {
              setLevels(next);
              refresh({ levels: next });
            }}
          />
        </div>
        <div className="log-daterange">
          <LogDateRangePicker
            value={range}
            onChange={(next) => {
              setRange(next);
              refresh({ range: next });
            }}
          />
        </div>
      </section>

      <section>
        <div className="flex items-center gap-3">
          <div className="log-search flex-1">
            <LogSearchBar
              logs={logs}
              onSearch={(next) => {
                setExpr(next);
                refresh({ expr: next });
              }}
              placeholder="level:'error' || message:'refresh'"
            />
          </div>
          <button
            onClick={() => setShowHelp((shown) => !shown)}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            {showHelp ? 'Hide syntax' : 'Syntax'}
          </button>
        </div>
        {showHelp && (
          <div className="log-help mt-2 rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900/60">
            <LogSearchSyntaxHelp />
          </div>
        )}
      </section>

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span>
            {ordered.length} record{ordered.length === 1 ? '' : 's'}
          </span>
          <span className={pending ? 'text-sky-500' : 'invisible'}>loading…</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="log-table-wrap log-table">
            <LogTable sort={sort} onSortChange={onSortChange} extraColumns={COLUMNS}>
              {pageLogs.map((log) => (
                <LogTableRowGroup key={log.id} log={log} />
              ))}
            </LogTable>
          </div>

          <div className="log-cards">
            {pageLogs.map((log) => (
              <LogCard key={log.id} log={log} fields={COLUMNS} />
            ))}
          </div>

          {ordered.length === 0 && !error && (
            <p className="px-4 py-10 text-center text-sm text-slate-400">
              No activity {describeWindow(range)}. The page starts at the last {DEFAULT_WINDOW_DAYS}{' '}
              days — widen the range, or clear both dates for all time.
            </p>
          )}
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-1 border-t border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
            <button
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
              className="rounded border border-slate-300 px-2 py-1 text-slate-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
            >
              ‹ Prev
            </button>
            <span className="px-3 text-slate-500 dark:text-slate-400" aria-live="polite">
              Page {current} of {pageCount}
            </span>
            <button
              disabled={current === pageCount}
              onClick={() => setPage(current + 1)}
              className="rounded border border-slate-300 px-2 py-1 text-slate-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
            >
              Next ›
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
