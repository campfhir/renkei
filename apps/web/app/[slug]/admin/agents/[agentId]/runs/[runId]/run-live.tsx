'use client';

/**
 * Admin run detail, kept current the same way the owner page is (see the
 * sibling RunLive at app/[slug]/agents/[agentId]/runs/[runId]/run-live.tsx):
 * one EventSource onto the admin stream route, no polling. There is no
 * pause card and no Cancel/Rerun swap here — oversight is read-only — so
 * this is the smaller half of that component.
 */

import { useEffect, useState } from 'react';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import CopyDebugButton from '@/components/copy-debug-button';
import { RunTimeline, StatusPill } from '../../../../../agents/run-timeline';
import RunActivitySection from '../../../../../agents/run-activity';
import { renderRunDebugMarkdown } from '@/lib/agents/run-debug';
import { isRunSettled } from '@/lib/agents/run-labels';
import type { RunDetail } from '@/lib/agents/runs-view';

export default function AdminRunLive({
  slug,
  agentId,
  runId,
  agentName,
  initialRun,
}: {
  slug: string;
  agentId: string;
  runId: string;
  agentName: string;
  initialRun: RunDetail;
}) {
  const [run, setRun] = useState(initialRun);

  useEffect(() => {
    if (isRunSettled(initialRun.status)) return;

    const source = new EventSource(`/api/admin/${slug}/agents/${agentId}/runs/${runId}/stream`);
    source.addEventListener('run', (event: MessageEvent<string>) => {
      try {
        const parsed: { run: RunDetail } = JSON.parse(event.data);
        setRun(parsed.run);
        if (isRunSettled(parsed.run.status)) source.close();
      } catch {
        // A malformed payload is not worth tearing the view down for.
      }
    });
    return () => source.close();
  }, [slug, agentId, runId, initialRun.status]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BackLink href={`/${slug}/admin/agents/${agentId}/runs`} label="Runs" />
        <h1 className="text-xl font-bold">Run</h1>
        <StatusPill status={run.status} />
        <span className="text-sm text-gray-500">
          via {run.triggerKind} · <LocalTime at={run.createdAt} />
        </span>
        {/* Offered on every run. The content inside is already redacted at
            the query seam for this audience — a succeeded run's attempts and
            trigger input are withheld — so the button being present is not
            the same as its contents being readable. */}
        <CopyDebugButton text={renderRunDebugMarkdown(agentName, run)} />
      </div>
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
