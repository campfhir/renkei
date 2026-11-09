import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import BackLink from '@/components/back-link';
import { Pager } from '@/components/data-table';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { ORG_QUEUE_PAGE_SIZE, countOrgQueue, listOrgQueue } from '@/lib/agents/org-queue';
import { pageFromParam } from '../../../agents/[agentId]/runs/runs-page.model';
import { isLiveTab, queueRows, tabLabels, type LiveTab } from './org-queue.model';
import OrgQueueTable from './org-queue-table';

/**
 * Every agent's queue at once, for an operator: each live run in the
 * organization (queued, running, waiting), oldest first, with its agent,
 * owner, status and how long it has waited — and a halt, per run or for
 * the runs picked, to clear a backlog. No run content: names, owners,
 * states and times only. ROLE_OPERATOR, like the rest of admin/agents.
 */
export default async function OrgQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) redirect('/admin');

  const { status, page: pageParam } = await searchParams;
  const tab: LiveTab | undefined = isLiveTab(status) ? status : undefined;
  const page = pageFromParam(pageParam);
  const [fetched, counts] = await Promise.all([
    listOrgQueue({
      ...(tab ? { statuses: [tab] } : {}),
      limit: ORG_QUEUE_PAGE_SIZE + 1,
      offset: (page - 1) * ORG_QUEUE_PAGE_SIZE,
    }),
    countOrgQueue(),
  ]);
  const loadedAt = Date.now();
  const rows = queueRows(fetched.slice(0, ORG_QUEUE_PAGE_SIZE), loadedAt);
  const hasNext = fetched.length > ORG_QUEUE_PAGE_SIZE;
  const first = (page - 1) * ORG_QUEUE_PAGE_SIZE + 1;

  const href = (target: { status?: LiveTab; page?: number }) => {
    const params = new URLSearchParams();
    if (target.status) params.set('status', target.status);
    if (target.page && target.page > 1) params.set('page', String(target.page));
    const search = params.toString();
    return search ? `/admin/agents/queue?${search}` : '/admin/agents/queue';
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-1 flex items-center gap-2">
        <BackLink href="/admin/agents" label="Agent oversight" />
        <h1 className="text-xl font-bold">Agent queue</h1>
      </div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Every run in this organization that has not finished, oldest first: which agent, whose, and
        how long it has waited. One agent&apos;s runs go one at a time, so a run stuck at the head
        holds the rest of that agent&apos;s queue. Halting a run stops it at once and clears its
        queue jobs; its owner sees it as Halted.
      </p>
      <nav aria-label="Run status" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {tabLabels(counts).map((item) => (
          <Link
            key={item.label}
            href={href({ status: item.value })}
            aria-current={item.value === tab ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 ${
              item.value === tab
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <OrgQueueTable
        rows={rows}
        empty={
          rows.length > 0
            ? null
            : page > 1
              ? 'No runs on this page.'
              : tab
                ? `No runs are ${tab}.`
                : 'Nothing is queued or running in this organization.'
        }
        footer={
          <Pager
            label="Queue pages"
            range={
              rows.length > 0
                ? `Runs ${first}–${first + rows.length - 1}`
                : page > 1
                  ? `Page ${page}`
                  : null
            }
            previousHref={page > 1 ? href({ status: tab, page: page - 1 }) : null}
            nextHref={hasNext ? href({ status: tab, page: page + 1 }) : null}
          />
        }
      />
    </div>
  );
}
