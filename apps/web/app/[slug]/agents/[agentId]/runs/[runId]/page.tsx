import BackLink from '@/components/back-link';
import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { getRunForOwner } from '@/lib/agents/runs-view';
import { RunTimeline, StatusPill } from '../../../run-timeline';
import RunActivitySection from '../../../run-activity';
import ApprovalActions from '../../../../approval-actions';
import QuestionActions from '../../../../question-actions';
import { parseFormNodes } from '@renkei/agents';
import LocalTime from '@/components/local-time';
import CopyDebugButton from '@/components/copy-debug-button';
import RerunButton from './rerun-button';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';

/** The `form` field a question card's suggested_action carries, if any. */
function formFieldOf(suggestedAction: unknown): unknown {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return undefined;
  const record: { form?: unknown } =
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
    suggestedAction as { form?: unknown };
  return record.form;
}

/**
 * One run with every attempt's full content — the owner's view, which a
 * grantee through an unexpired access grant shares (unredacted run detail
 * is the whole point of a troubleshooting share).
 */
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
  const access = await resolveAgentAccess(dbResult.val, tenant.id, session.subject, agentId);
  if (!access) notFound();
  const agent = access.agent;
  const run = await getRunForOwner(dbResult.val, tenant.id, access.ownerSubject, agentId, runId);
  if (!run) notFound();

  // The run page mirrors the home-page pause card while the run waits, so
  // the person reading the timeline can decide right here. The card is
  // the OWNER's decision to make — approving spends their grants — so a
  // grantee reads the timeline without it.
  const pauseCard =
    access.viewerIsOwner && run.status === 'waiting'
      ? await dbResult.val
          .selectFrom('actionable_items')
          .select(['id', 'kind', 'status', 'summary', 'suggested_action'])
          .where('run_id', '=', runId)
          .where((eb) => eb.or([eb('kind', '=', 'approval'), eb('kind', '=', 'question')]))
          .where('status', '=', 'suggested')
          .where('owner_subject', '=', session.subject)
          .orderBy('created_at', 'desc')
          .executeTakeFirst()
      : null;
  const questionForm =
    pauseCard?.kind === 'question' ? parseFormNodes(formFieldOf(pauseCard.suggested_action)) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/agents/${agentId}/runs`} label={`Runs of “${agent.name}”`} />
        <h1 className="text-xl font-bold">Run</h1>
        <StatusPill status={run.status} />
        <span className="text-sm text-gray-500">
          via {run.triggerKind} · <LocalTime at={run.createdAt} />
        </span>
        {/* Offered on EVERY run, not only failed ones. An agent that
            "misbehaved" has usually succeeded at doing the wrong thing, and
            that is exactly the run someone needs to paste somewhere. */}
        <CopyDebugButton text={renderRunDebugMarkdown(agent.name, run)} />
        {/* Only once the run is settled — a rerun while it is still going
            would put two runs on the same message at once. */}
        {run.status === 'queued' || run.status === 'running' || run.status === 'waiting' ? null : (
          <RerunButton tenantId={tenant.id} slug={slug} agentId={agentId} runId={runId} />
        )}
      </div>
      {pauseCard ? (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/30">
          <p className="mb-2 whitespace-pre-wrap text-sm font-medium">{pauseCard.summary}</p>
          {pauseCard.kind === 'question' ? (
            <QuestionActions tenantId={tenant.id} itemId={pauseCard.id} form={questionForm} />
          ) : (
            <ApprovalActions tenantId={tenant.id} itemId={pauseCard.id} />
          )}
        </div>
      ) : null}
      {run.error ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {run.error}
        </p>
      ) : null}
      <RunActivitySection run={run} />
      <RunTimeline run={run} />
    </div>
  );
}
