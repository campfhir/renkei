import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent } from '@/lib/agents/store';
import { getRunForOwner } from '@/lib/agents/runs-view';
import { RunTimeline, StatusPill } from '../../../run-timeline';
import LocalTime from '@/components/local-time';
import CopyDebugButton from '@/components/copy-debug-button';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';

/** One run, owner's view: every attempt with full content. */
export default async function AgentRunDetailPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string; runId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId, runId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/${agentId}/runs/${runId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const agent = await getAgent(dbResult.val, tenant.id, session.subject, agentId);
  if (!agent) notFound();
  const run = await getRunForOwner(dbResult.val, tenant.id, session.subject, agentId, runId);
  if (!run) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm">
        <Link
          href={`/${slug}/agents/${agentId}/runs`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          ← Runs of “{agent.name}”
        </Link>
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">Run</h1>
        <StatusPill status={run.status} />
        <span className="text-sm text-gray-500">
          via {run.triggerKind} · <LocalTime at={run.createdAt} />
        </span>
        {run.status === 'failed' || run.attempts.some((a) => a.status === 'failed') ? (
          <CopyDebugButton text={renderRunDebugMarkdown(agent.name, run)} />
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
