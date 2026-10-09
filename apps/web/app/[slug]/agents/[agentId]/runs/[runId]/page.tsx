import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { getOwnerRunPageData } from '@/lib/agents/run-page-data';
import RunLive from './run-live';

/**
 * One run with every attempt's full content — the owner's view, which a
 * grantee through an unexpired access grant shares (unredacted run detail
 * is the whole point of a troubleshooting share).
 *
 * Only fetches the FIRST paint; everything below the fold is then kept
 * current by RunLive's own live stream (its route re-runs this exact
 * projection — getOwnerRunPageData — on every change), not by this page
 * being asked to re-render.
 */
export default async function AgentRunDetailPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string; runId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId, runId } = await params;

  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/agents/${agentId}/runs/${runId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const access = await resolveAgentAccess(dbResult.val, session.subject, agentId);
  if (!access) notFound();
  const agent = access.agent;
  const data = await getOwnerRunPageData(
    dbResult.val,
    access.ownerSubject,
    access.viewerIsOwner,
    agentId,
    runId
  );
  if (!data) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <RunLive
        slug={slug}
        agentId={agentId}
        runId={runId}
        agentName={agent.name}
        initialData={data}
      />
    </div>
  );
}
