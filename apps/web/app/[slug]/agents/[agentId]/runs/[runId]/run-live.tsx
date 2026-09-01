'use client';

/**
 * The run detail page, kept current by the server rather than by us asking
 * for it: one `EventSource` onto the run's stream route replaces the
 * page's initial data whenever the run row, a step attempt, or its pause
 * card changes, and every child here — the status pill, the pause card,
 * the debug text, the Cancel/Rerun swap, the activity feed, the timeline —
 * re-renders off that same state. No polling interval, no page reload.
 *
 * Owns the whole content area (not just the dynamic slivers) so the
 * flex header stays one component instead of a server/client split that
 * would have to agree on layout twice.
 */

import { useEffect, useState } from 'react';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import CopyDebugButton from '@/components/copy-debug-button';
import { RunTimeline, StatusPill } from '../../../run-timeline';
import RunActivitySection from '../../../run-activity';
import ApprovalActions from '../../../../approval-actions';
import QuestionActions from '../../../../question-actions';
import RerunButton from './rerun-button';
import CancelButton from './cancel-button';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';
import { isRunSettled } from '@/lib/agents/run-labels';
import type { OwnerRunPageData } from '@/lib/agents/run-page-data';

export default function RunLive({
  tenantId,
  slug,
  agentId,
  runId,
  agentName,
  initialData,
}: {
  tenantId: string;
  slug: string;
  agentId: string;
  runId: string;
  agentName: string;
  initialData: OwnerRunPageData;
}) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    // A run that already loaded settled will never move again — nothing
    // for a stream to tell us.
    if (isRunSettled(initialData.run.status)) return;

    const source = new EventSource(
      `/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/stream`
    );
    source.addEventListener('run', (event: MessageEvent<string>) => {
      try {
        const parsed: OwnerRunPageData = JSON.parse(event.data);
        setData(parsed);
        // The server ends the stream once a run settles, but a browser
        // EventSource retries a server-closed connection by default —
        // closing it ourselves the moment we see why is what stops that.
        if (isRunSettled(parsed.run.status)) source.close();
      } catch {
        // A malformed payload is not worth tearing the view down for —
        // the next event (or the server's own safety-net re-read) fixes it.
      }
    });
    return () => source.close();
  }, [tenantId, agentId, runId, initialData.run.status]);

  const { run, pauseCard, questionForm } = data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/agents/${agentId}/runs`} label={`Runs of “${agentName}”`} />
        <h1 className="text-xl font-bold">Run</h1>
        <StatusPill status={run.status} />
        <span className="text-sm text-gray-500">
          via {run.triggerKind} · <LocalTime at={run.createdAt} />
        </span>
        {/* Offered on EVERY run, not only failed ones. An agent that
            "misbehaved" has usually succeeded at doing the wrong thing, and
            that is exactly the run someone needs to paste somewhere. */}
        <CopyDebugButton text={renderRunDebugMarkdown(agentName, run)} />
        {/* Exactly one of these two is ever offered: a run that hasn't
            settled can be canceled; a settled one can be rerun. Never
            both — a rerun while it is still going would put two runs on
            the same message at once. */}
        {!isRunSettled(run.status) ? (
          <CancelButton tenantId={tenantId} agentId={agentId} runId={runId} />
        ) : (
          <RerunButton
            tenantId={tenantId}
            slug={slug}
            agentId={agentId}
            runId={runId}
            agentName={agentName}
          />
        )}
      </div>
      {pauseCard ? (
        <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50/50 p-4 dark:border-sky-900 dark:bg-sky-950/30">
          <p className="mb-2 whitespace-pre-wrap text-sm font-medium">{pauseCard.summary}</p>
          {pauseCard.kind === 'question' ? (
            <QuestionActions tenantId={tenantId} itemId={pauseCard.id} form={questionForm} />
          ) : (
            <ApprovalActions tenantId={tenantId} itemId={pauseCard.id} />
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
    </>
  );
}
