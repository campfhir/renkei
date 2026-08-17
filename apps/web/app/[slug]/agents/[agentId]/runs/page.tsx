import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent } from '@/lib/agents/store';
import { listRunsForOwner } from '@/lib/agents/runs-view';
import { StatusPill } from '../../run-timeline';
import LocalTime from '@/components/local-time';

/** The owner's run list — full visibility over their own agent's history. */
export default async function AgentRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; agentId: string }>;
  searchParams: Promise<{ status?: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId } = await params;
  const { status } = await searchParams;
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

  const filter = status === 'succeeded' || status === 'failed' ? status : undefined;
  const runs = await listRunsForOwner(dbResult.val, tenant.id, session.subject, agentId, {
    status: filter,
  });

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm">
        <Link
          href={`/${slug}/agents/${agentId}`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          ← “{agent.name}”
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-bold">Runs of “{agent.name}”</h1>
      <div className="mb-4 flex gap-2 text-sm">
        {[
          { label: 'All', href: `/${slug}/agents/${agentId}/runs` },
          { label: 'Succeeded', href: `/${slug}/agents/${agentId}/runs?status=succeeded` },
          { label: 'Failed', href: `/${slug}/agents/${agentId}/runs?status=failed` },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tab.href}
            className={`rounded-full border px-3 py-1 ${
              tab.label.toLowerCase() === (filter ?? 'all')
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No runs yet.</p>
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
                    <span className="text-xs text-red-600 dark:text-red-400">{run.errorKind}</span>
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
    </div>
  );
}
