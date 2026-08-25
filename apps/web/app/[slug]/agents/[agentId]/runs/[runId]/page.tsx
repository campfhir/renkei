import BackLink from '@/components/back-link';
import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent } from '@/lib/agents/store';
import { getRunForOwner } from '@/lib/agents/runs-view';
import { RunTimeline, StatusPill } from '../../../run-timeline';
import ApprovalActions from '../../../../approval-actions';
import LocalTime from '@/components/local-time';
import CopyDebugButton from '@/components/copy-debug-button';
import RerunButton from './rerun-button';
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

  // The run page mirrors the home-page approval card while the run waits,
  // so the person reading the timeline can decide right here.
  const approvalCard =
    run.status === 'waiting'
      ? await dbResult.val
          .selectFrom('actionable_items')
          .select(['id', 'status', 'summary', 'suggested_action'])
          .where('run_id', '=', runId)
          .where('kind', '=', 'approval')
          .where('status', '=', 'suggested')
          .where('owner_subject', '=', session.subject)
          .orderBy('created_at', 'desc')
          .executeTakeFirst()
      : null;
  const approvalMode = (() => {
    if (
      typeof approvalCard?.suggested_action !== 'object' ||
      approvalCard.suggested_action === null
    )
      return 'approve' as const;
    const record: Record<string, unknown> = { ...approvalCard.suggested_action };
    return record.approvalMode === 'input' ? ('input' as const) : ('approve' as const);
  })();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/agents/${agentId}/runs`} label={`Runs of “${agent.name}”`} />
        <h1 className="text-xl font-bold">Run</h1>
        <StatusPill status={run.status} />
        <span className="text-sm text-gray-500">
          via {run.triggerKind} · <LocalTime at={run.createdAt} />
        </span>
        {run.status === 'failed' || run.attempts.some((a) => a.status === 'failed') ? (
          <CopyDebugButton text={renderRunDebugMarkdown(agent.name, run)} />
        ) : null}
        {/* Only once the run is settled — a rerun while it is still going
            would put two runs on the same message at once. */}
        {run.status === 'queued' || run.status === 'running' || run.status === 'waiting' ? null : (
          <RerunButton tenantId={tenant.id} slug={slug} agentId={agentId} runId={runId} />
        )}
      </div>
      {approvalCard ? (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/30">
          <p className="mb-2 whitespace-pre-wrap text-sm font-medium">{approvalCard.summary}</p>
          <ApprovalActions tenantId={tenant.id} itemId={approvalCard.id} mode={approvalMode} />
        </div>
      ) : null}
      {run.error ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {run.error}
        </p>
      ) : null}
      <RunTimeline run={run} />
    </div>
  );
}
