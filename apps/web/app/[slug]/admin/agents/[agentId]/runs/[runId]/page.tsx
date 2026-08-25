import BackLink from '@/components/back-link';
import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getRunForAdmin } from '@/lib/agents/runs-view';
import { RunTimeline, StatusPill } from '../../../../../agents/run-timeline';
import LocalTime from '@/components/local-time';
import CopyDebugButton from '@/components/copy-debug-button';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';

/**
 * Admin run detail. The projection this page receives already withheld
 * content on every non-failed attempt (runs-view.ts); the timeline renders
 * those as "details hidden".
 */
export default async function AdminRunDetailPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string; runId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId, runId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  if (!(await checkAccess(tenant.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const run = await getRunForAdmin(dbResult.val, tenant.id, agentId, runId);
  if (!run) notFound();
  const agentRow = await dbResult.val
    .selectFrom('agents')
    .select('name')
    .where('tenant_id', '=', tenant.id)
    .where('id', '=', agentId)
    .executeTakeFirst();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/admin/agents/${agentId}/runs`} label="Runs" />
        <h1 className="text-xl font-bold">Run</h1>
        <StatusPill status={run.status} />
        <span className="text-sm text-gray-500">
          via {run.triggerKind} · <LocalTime at={run.createdAt} />
        </span>
        {run.status === 'failed' || run.attempts.some((a) => a.status === 'failed') ? (
          <CopyDebugButton text={renderRunDebugMarkdown(agentRow?.name ?? 'agent', run)} />
        ) : null}
      </div>
      {run.error ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {run.error}
        </p>
      ) : null}
      <RunTimeline run={run} />
    </div>
  );
}
