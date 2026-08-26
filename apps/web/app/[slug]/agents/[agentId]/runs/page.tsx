import BackLink from '@/components/back-link';
import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent } from '@/lib/agents/store';
import { isRunStatus, listRunsForOwner } from '@/lib/agents/runs-view';
import { StatusPill } from '../../run-timeline';
import RunsSearch from '../../runs-search';
import { errorSummary, statusLabel } from '@/lib/agents/run-labels';
import LocalTime from '@/components/local-time';

/** The status tabs the pages offer; 'queued' stays reachable via All. */
const STATUS_TABS = ['succeeded', 'failed', 'stopped', 'waiting', 'running', 'canceled'] as const;

/** The owner's run list — full visibility over their own agent's history. */
export default async function AgentRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; agentId: string }>;
  searchParams: Promise<{ status?: string; q?: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId } = await params;
  const { status, q } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/${agentId}/runs`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const agent = await getAgent(dbResult.val, tenant.id, session.subject, agentId);
  if (!agent) notFound();

  const filter = isRunStatus(status) ? status : undefined;
  const query = typeof q === 'string' && q.trim() ? q.trim() : undefined;
  const runs = await listRunsForOwner(dbResult.val, tenant.id, session.subject, agentId, {
    status: filter,
    ...(query ? { q: query } : {}),
  });

  const basePath = `/${slug}/agents/${agentId}/runs`;
  const tabHref = (tabStatus?: string) => {
    const params = new URLSearchParams();
    if (tabStatus) params.set('status', tabStatus);
    if (query) params.set('q', query);
    const search = params.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-center gap-2">
        <BackLink href={`/${slug}/agents/${agentId}`} label={`“${agent.name}”`} />
        <h1 className="min-w-0 truncate text-xl font-bold">Runs of “{agent.name}”</h1>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
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
      </div>
      <div className="mb-4">
        <RunsSearch basePath={basePath} status={filter} initialQ={query ?? ''} />
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {query || filter ? 'No runs match.' : 'No runs yet.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                href={`/${slug}/agents/${agentId}/runs/${run.id}`}
                className="flex items-center justify-between rounded-md border border-gray-200 p-3 text-sm hover:border-blue-400 dark:border-gray-800"
              >
                <span className="flex items-center gap-2">
                  <StatusPill status={run.status} />
                  <span className="text-gray-600 dark:text-gray-400">via {run.triggerKind}</span>
                  {run.errorKind ? (
                    <span className="text-xs text-red-600 dark:text-red-400">
                      {errorSummary(run.errorKind, run.failedStepName)}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-gray-500">
                  <LocalTime at={run.createdAt} />
                  {run.durationMs !== null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {runs.length === 50 ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          Showing the newest 50 matching runs — narrow with the search or a status tab to reach
          older ones.
        </p>
      ) : null}
    </div>
  );
}
