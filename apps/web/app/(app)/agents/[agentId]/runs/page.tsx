import BackLink from '@/components/back-link';
import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { isRunStatus, listRunsForOwner } from '@/lib/agents/runs-view';
import { StatusPill } from '../../run-timeline';
import RunsSearch from '../../runs-search';
import { errorSummary, statusLabel } from '@/lib/agents/run-labels';
import LocalTime from '@/components/local-time';
import CoachTarget from '@/components/coach-marks/anchor';
import { pageFromParam, pageQuery, pageWindow, runsPageHref } from './runs-page.model';

/**
 * The status tabs the page offers. Queued has its own: the agents page's
 * overview links a stuck queue straight to it.
 */
const STATUS_TABS = [
  'succeeded',
  'failed',
  'stopped',
  'waiting',
  'running',
  'queued',
  'canceled',
] as const;

/**
 * The run list, full visibility: the owner, or a grantee through an
 * unexpired access grant — the grant exists to troubleshoot, so a grantee
 * reads the history exactly as the owner does.
 */
export default async function AgentRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}): Promise<React.ReactNode> {
  const { agentId } = await params;
  const { status, q, page: pageParam } = await searchParams;

  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/agents/${agentId}/runs`));
  }

  const access = await resolveAgentAccess(session.subject, agentId);
  if (!access) notFound();
  const agent = access.agent;

  const filter = isRunStatus(status) ? status : undefined;
  const query = typeof q === 'string' && q.trim() ? q.trim() : undefined;
  const page = pageFromParam(pageParam);
  const fetched = await listRunsForOwner(access.ownerSubject, agentId, {
    status: filter,
    ...(query ? { q: query } : {}),
    ...pageQuery(page),
  });
  const paging = pageWindow(fetched, page);
  const runs = paging.rows;

  const basePath = `/agents/${agentId}/runs`;
  // A tab or a search starts again from page 1.
  const tabHref = (tabStatus?: string) =>
    runsPageHref(basePath, { status: tabStatus, q: query, page: 1 });
  const pageHref = (target: number) =>
    runsPageHref(basePath, { status: filter, q: query, page: target });

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-center gap-2">
        <BackLink href={`/agents/${agentId}`} label={`“${agent.name}”`} />
        <h1 className="min-w-0 truncate text-xl font-bold">Runs of “{agent.name}”</h1>
      </div>
      <CoachTarget name="runs-filters" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {[
          { label: 'All', value: undefined },
          ...STATUS_TABS.map((value) => ({ label: statusLabel(value), value })),
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tabHref(tab.value)}
            className={`rounded-full border px-3 py-1 ${
              tab.value === filter
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </CoachTarget>
      <div className="mb-4">
        <RunsSearch basePath={basePath} status={filter} initialQ={query ?? ''} />
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {page > 1 ? 'No runs on this page.' : query || filter ? 'No runs match.' : 'No runs yet.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th scope="col" className="py-2 pl-3 pr-2 font-medium">
                  Started
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">
                  Trigger
                </th>
                <th
                  scope="col"
                  className="hidden py-2 pl-2 pr-3 text-right font-medium sm:table-cell"
                >
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className="border-t border-gray-100 align-top hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                >
                  <td className="whitespace-nowrap py-2 pl-3 pr-2">
                    <Link
                      href={`/agents/${agentId}/runs/${run.id}`}
                      className="text-blue-700 hover:underline dark:text-blue-400"
                    >
                      <LocalTime at={run.createdAt} />
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    <StatusPill status={run.status} errorKind={run.errorKind} />
                    {run.errorKind ? (
                      <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400">
                        {errorSummary(run.errorKind)}
                      </span>
                    ) : null}
                    {/* On a phone the trigger column is gone; it rides here. */}
                    <span className="mt-0.5 block text-xs text-gray-500 sm:hidden">
                      via {run.triggerKind}
                    </span>
                  </td>
                  <td className="hidden px-2 py-2 text-gray-600 dark:text-gray-400 sm:table-cell">
                    {run.triggerKind}
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pl-2 pr-3 text-right text-gray-600 tabular-nums dark:text-gray-400 sm:table-cell">
                    {run.durationMs !== null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paging.hasPrevious || paging.hasNext ? (
        <nav
          aria-label="Runs pages"
          className="mt-3 flex items-center justify-between gap-2 text-sm"
        >
          {paging.hasPrevious ? (
            <Link
              href={pageHref(page - 1)}
              className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {paging.range ?? `Page ${page}`}
          </span>
          {paging.hasNext ? (
            <Link
              href={pageHref(page + 1)}
              className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
