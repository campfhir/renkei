import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getAgentForAdmin, getRunForAdmin } from '@/lib/agents/runs-view';
import AdminRunLive from './run-live';

/**
 * Admin run detail. The projection this page receives already withheld
 * content on every non-failed attempt (runs-view.ts); the timeline renders
 * those as "details hidden".
 *
 * Only fetches the first paint; AdminRunLive keeps everything below the
 * header current via its own live stream, not by this page re-rendering.
 */
export default async function AdminRunDetailPage({
  params,
}: {
  params: Promise<{ agentId: string; runId: string }>;
}): Promise<React.ReactNode> {
  const { agentId, runId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  const [run, agentRow] = await Promise.all([
    getRunForAdmin(agentId, runId),
    getAgentForAdmin(agentId),
  ]);
  if (!run) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <AdminRunLive
        agentId={agentId}
        runId={runId}
        agentName={agentRow?.name ?? 'agent'}
        initialRun={run}
      />
    </div>
  );
}
