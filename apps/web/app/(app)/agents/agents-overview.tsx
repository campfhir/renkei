import React from 'react';
import Link from 'next/link';
import ListPager from './list-pager';
import type { ListPage } from './agents-page.model';
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

function Row({ row }: { row: OverviewRow }) {
  return (
    <tr className="border-t border-gray-100 align-top dark:border-gray-800">
      <td className="py-2 pl-3 pr-2">
        <Link
          href={row.href}
          className="font-medium text-gray-900 hover:text-blue-700 hover:underline dark:text-gray-100 dark:hover:text-blue-400"
        >
          {row.name}
        </Link>
        {row.shared || !row.enabled ? (
          <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">
            {[row.shared ? 'shared' : null, row.enabled ? null : 'off'].filter(Boolean).join(' · ')}
          </span>
        ) : null}
        {/* On a phone the age column is gone; its value rides under the name. */}
        {row.oldestAge ? (
          <span className="block text-xs text-gray-500 dark:text-gray-400 sm:hidden">
            oldest {row.oldestAge}
          </span>
        ) : null}
      </td>
      <td
        className={`px-2 py-2 ${
          row.state === 'idle'
            ? 'text-gray-500 dark:text-gray-400'
            : 'text-gray-800 dark:text-gray-200'
        }`}
      >
        {row.inFlight}
      </td>
      <td className="hidden whitespace-nowrap px-2 py-2 text-gray-600 dark:text-gray-400 sm:table-cell">
        {row.oldestAge ?? '—'}
      </td>
      <td className="py-2 pl-2 pr-3 text-right">
        <StateBadge state={row.state} />
      </td>
    </tr>
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
  return (
    <section aria-labelledby="agents-overview-heading" className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="agents-overview-heading" className="text-base font-semibold">
          In flight
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{overviewHeadline(overview)}</p>
      </div>
      <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            <tr>
              <th scope="col" className="py-2 pl-3 pr-2 font-medium">
                Agent
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Queued, running, waiting
              </th>
              <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">
                Oldest
              </th>
              <th scope="col" className="py-2 pl-2 pr-3 text-right font-medium">
                <span className="sr-only">State</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row) => (
              <Row key={row.agentId} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      <ListPager
        label="In flight pages"
        range={page.range ? `Agents ${page.range}` : null}
        previousHref={previousHref}
        nextHref={nextHref}
        keepScroll
      />
    </section>
  );
}
