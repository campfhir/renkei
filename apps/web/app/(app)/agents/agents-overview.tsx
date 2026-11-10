import React from 'react';
import Link from 'next/link';
import { DataFrame, DataTable, Pager, Th } from '@/components/data-table';
import { fillerRows, type ListPage } from './agents-page.model';
import {
  overviewHeadline,
  type Overview,
  type OverviewRow,
  type OverviewState,
} from './agents-overview.model';

/**
 * "In flight" — every agent's queued, running and waiting runs at a
 * glance, above the agent cards, so a stuck agent shows before you go
 * looking for it. What each row says is agents-overview.model.ts; this
 * only draws it. Server-rendered: a reload is the refresh.
 */

const STATE_LABEL: Record<OverviewState, string> = {
  stuck: 'Stuck',
  'needs-you': 'Needs you',
  busy: 'Working',
  idle: 'Idle',
};

const STATE_TONE: Record<OverviewState, string> = {
  stuck: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  'needs-you': 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  busy: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  idle: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

function StateBadge({ state }: { state: OverviewState }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** "shared", "off", or both — beside the agent's name. */
function tagsOf(row: OverviewRow): string | null {
  const tags = [row.shared ? 'shared' : null, row.enabled ? null : 'off'].filter(Boolean);
  return tags.length > 0 ? tags.join(' · ') : null;
}

/**
 * Every row and every card is a fixed height — names truncate (the full
 * name is on the link's title) — so a page of ten is always the same height
 * and the pager under it never moves. The heights are shared with the
 * blank rows and cards that pad a short last page.
 */
const ROW_HEIGHT = 'h-11';
const CARD_HEIGHT = 'h-[4.25rem]';

/** One agent as a table row: from the `sm` breakpoint up. */
function Row({ row }: { row: OverviewRow }) {
  const tags = tagsOf(row);
  return (
    <tr className={`${ROW_HEIGHT} border-t border-gray-100 dark:border-gray-800`}>
      <td className="px-3 align-middle">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <Link
            href={row.href}
            title={row.name}
            className="truncate font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-400"
          >
            {row.name}
          </Link>
          {tags ? (
            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{tags}</span>
          ) : null}
        </div>
      </td>
      <td
        className={`truncate px-3 align-middle ${
          row.state === 'idle'
            ? 'text-gray-500 dark:text-gray-400'
            : 'text-gray-800 dark:text-gray-200'
        }`}
      >
        {row.inFlight}
      </td>
      <td className="truncate px-3 align-middle text-gray-600 dark:text-gray-400">
        {row.oldestAge ?? '—'}
      </td>
      <td className="px-3 text-right align-middle">
        <StateBadge state={row.state} />
      </td>
    </tr>
  );
}

/**
 * One agent as a card: on a phone, where four columns do not fit. The whole
 * card is the link (a thumb-sized target), name and state on top, what it
 * has in flight and the oldest run's age beneath.
 */
function Card({ row }: { row: OverviewRow }) {
  const tags = tagsOf(row);
  return (
    <li className={CARD_HEIGHT}>
      <Link
        href={row.href}
        title={row.name}
        className="flex h-full flex-col justify-center gap-1 rounded-lg border border-gray-200 px-3 hover:border-blue-400 dark:border-gray-800"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-gray-900 dark:text-gray-100">{row.name}</span>
          {tags ? (
            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{tags}</span>
          ) : null}
          <span className="ml-auto shrink-0">
            <StateBadge state={row.state} />
          </span>
        </span>
        <span
          className={`truncate text-xs ${
            row.state === 'idle'
              ? 'text-gray-500 dark:text-gray-400'
              : 'text-gray-700 dark:text-gray-300'
          }`}
        >
          {row.inFlight}
          {row.oldestAge ? ` · oldest ${row.oldestAge}` : ''}
        </span>
      </Link>
    </li>
  );
}

export default function AgentsOverview({
  overview,
  page,
  previousHref,
  nextHref,
}: {
  /** Every agent's row: the headline totals all of them. */
  overview: Overview;
  /** The rows this page shows, ten at a time, the ones needing attention first. */
  page: ListPage<OverviewRow>;
  previousHref: string | null;
  nextHref: string | null;
}): React.ReactNode {
  if (overview.rows.length === 0) return null;
  // A short last page is padded to ten, so the pager holds its place.
  const fillers = Array.from({ length: fillerRows(page) }, (_, index) => index);
  return (
    <section aria-labelledby="agents-overview-heading" className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="agents-overview-heading" className="text-base font-semibold">
          In flight
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{overviewHeadline(overview)}</p>
      </div>
      <DataFrame
        label="Agents in flight"
        table={
          <DataTable
            head={
              <>
                <Th className="w-[44%]">Agent</Th>
                <Th>Queued, running, waiting</Th>
                <Th className="w-20">Oldest</Th>
                <Th className="w-[6.5rem] text-right">
                  <span className="sr-only">State</span>
                </Th>
              </>
            }
          >
            {page.rows.map((row) => (
              <Row key={row.agentId} row={row} />
            ))}
            {fillers.map((index) => (
              <tr key={`filler-${index}`} aria-hidden="true" className={ROW_HEIGHT}>
                <td colSpan={4} />
              </tr>
            ))}
          </DataTable>
        }
        cards={
          <>
            {page.rows.map((row) => (
              <Card key={row.agentId} row={row} />
            ))}
            {fillers.map((index) => (
              <li key={`filler-${index}`} aria-hidden="true" className={CARD_HEIGHT} />
            ))}
          </>
        }
        footer={
          <Pager
            label="In flight pages"
            range={page.range ? `Agents ${page.range}` : null}
            previousHref={previousHref}
            nextHref={nextHref}
            keepScroll
          />
        }
      />
    </section>
  );
}
