import BackLink from '@/components/back-link';
import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { isRunStatus, listLiveRunCounts, listRunsForOwner } from '@/lib/agents/runs-view';
import { STUCK_AFTER_MS } from '@/lib/agents/stuck';
import { ageWords } from '../../agents-overview.model';
import HaltButton from './halt-button';
import { StatusPill } from '../../run-timeline';
import RunsSearch from '../../runs-search';
import { statusLabel, statusNote } from '@/lib/agents/run-labels';
import LocalTime from '@/components/local-time';
import CoachTarget from '@/components/coach-marks/anchor';
import { pageFromParam, pageQuery, pageWindow, runsPageHref } from './runs-page.model';
import { DataFrame, DataTable, Pager, Th } from '@/components/data-table';

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

  // Anything queued or running past the stuck horizon: offer to clear it.
  const loadedAt = Date.now();
  const stuckSince = (await listLiveRunCounts([agentId]))
    .filter((count) => count.status === 'queued' || count.status === 'running')
    .map((count) => loadedAt - Date.parse(count.oldestCreatedAt))
    .filter((age) => age > STUCK_AFTER_MS);
  const oldestStuck = stuckSince.length > 0 ? Math.max(...stuckSince) : null;
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

      {oldestStuck !== null ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <span>
            Runs have been stuck for over two hours (the oldest for {ageWords(oldestStuck)}). A
            cancel never reaches a stuck run; halting closes them out.
          </span>
          <HaltButton agentId={agentId} label="Halt stuck runs" />
        </div>
      ) : null}
      <DataFrame
        label="Runs"
        empty={
          runs.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              {page > 1
                ? 'No runs on this page.'
                : query || filter
                  ? 'No runs match.'
                  : 'No runs yet.'}
            </p>
          ) : undefined
        }
        table={
          <DataTable
            head={
              <>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th className="w-28">Trigger</Th>
                <Th className="w-24 text-right">Duration</Th>
              </>
            }
          >
            {runs.map((run) => (
              <tr
                key={run.id}
                className="border-t border-gray-100 align-top hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
              >
                <td className="whitespace-nowrap px-3 py-2">
                  <Link
                    href={`/agents/${agentId}/runs/${run.id}`}
                    className="text-blue-700 hover:underline dark:text-blue-400"
                  >
                    <LocalTime at={run.createdAt} />
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={run.status} errorKind={run.errorKind} />
                  {/* Why it failed — or nothing, when the pill already says it
                      (a halted run reads Halted). */}
                  {statusNote(run.status, run.errorKind) ? (
                    <span className="mt-0.5 block text-xs text-red-600 dark:text-red-400">
                      {statusNote(run.status, run.errorKind)}
                    </span>
                  ) : null}
                </td>
                <td className="truncate px-3 py-2 text-gray-600 dark:text-gray-400">
                  {run.triggerKind}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-gray-600 tabular-nums dark:text-gray-400">
                  {run.durationMs !== null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
              </tr>
            ))}
          </DataTable>
        }
        cards={runs.map((run) => (
          <li key={run.id}>
            <Link
              href={`/agents/${agentId}/runs/${run.id}`}
              className="block rounded-lg border border-gray-200 px-3 py-2 hover:border-blue-400 dark:border-gray-800"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm text-blue-700 dark:text-blue-400">
                  <LocalTime at={run.createdAt} />
                </span>
                <StatusPill status={run.status} errorKind={run.errorKind} />
              </span>
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                via {run.triggerKind}
                {run.durationMs !== null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                {statusNote(run.status, run.errorKind) ? (
                  <span className="text-red-600 dark:text-red-400">
                    {' '}
                    · {statusNote(run.status, run.errorKind)}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
        footer={
          <Pager
            label="Runs pages"
            range={paging.range ?? (page > 1 ? `Page ${page}` : null)}
            previousHref={paging.hasPrevious ? pageHref(page - 1) : null}
            nextHref={paging.hasNext ? pageHref(page + 1) : null}
            previousLabel="← Newer"
            nextLabel="Older →"
          />
        }
      />
    </div>
  );
}
