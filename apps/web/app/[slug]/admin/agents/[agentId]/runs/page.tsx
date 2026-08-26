import BackLink from '@/components/back-link';
import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { isRunStatus, listRunsForAdmin } from '@/lib/agents/runs-view';
import { StatusPill } from '../../../../agents/run-timeline';
import RunsSearch from '../../../../agents/runs-search';
import { errorSummary, statusLabel } from '@/lib/agents/run-labels';
import LocalTime from '@/components/local-time';

/** The status tabs the pages offer; 'queued' stays reachable via All. */
const STATUS_TABS = ['succeeded', 'failed', 'stopped', 'waiting', 'running', 'canceled'] as const;

/** Admin view: any agent's run statuses — content stays behind the detail rule. */
export default async function AdminAgentRunsPage({
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
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const agent = await db
    .selectFrom('agents')
    .select(['name'])
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', agentId)
    .executeTakeFirst();
  if (!agent) notFound();
  const filter = isRunStatus(status) ? status : undefined;
  const query = typeof q === 'string' && q.trim() ? q.trim() : undefined;
  const runs = await listRunsForAdmin(db, tenant.id, agentId, {
    status: filter,
    ...(query ? { q: query } : {}),
  });

  const basePath = `/${slug}/admin/agents/${agentId}/runs`;
  const tabHref = (tabStatus?: string) => {
    const tabParams = new URLSearchParams();
    if (tabStatus) tabParams.set('status', tabStatus);
    if (query) tabParams.set('q', query);
    const search = tabParams.toString();
    return search ? `${basePath}?${search}` : basePath;
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackLink href={`/${slug}/admin/agents`} label="Agent oversight" />
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
          {query || filter ? 'No runs match.' : 'No runs recorded.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                href={`/${slug}/admin/agents/${agentId}/runs/${run.id}`}
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
