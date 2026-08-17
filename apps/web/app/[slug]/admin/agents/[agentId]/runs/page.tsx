import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { listRunsForAdmin } from '@/lib/agents/runs-view';
import { StatusPill } from '../../../../agents/run-timeline';
import LocalTime from '@/components/local-time';

/** Admin view: any agent's run statuses — content stays behind the detail rule. */
export default async function AdminAgentRunsPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId } = await params;
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
  const runs = await listRunsForAdmin(db, tenant.id, agentId);

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm">
        <Link
          href={`/${slug}/admin/agents`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Agent oversight
        </Link>
      </p>
      <h1 className="mb-4 text-xl font-bold">Runs of “{agent.name}”</h1>
      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No runs recorded.</p>
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
                    <span className="text-xs text-red-600 dark:text-red-400">{run.errorKind}</span>
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
    </div>
  );
}
