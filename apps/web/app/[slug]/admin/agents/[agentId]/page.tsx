import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getDatabase } from '@renkei/db';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getAgentForAdmin } from '@/lib/agents/runs-view';
import { getAgentTokenUsage, getAgentToolUsage } from '@/lib/agents/agent-usage';
import BackLink from '@/components/back-link';
import LocalTime from '@/components/local-time';
import AgentUsagePanel from '@/components/agent-usage-panel';
import AdminAgentToggle from './admin-agent-toggle';

const TOOL_USAGE_WINDOW_DAYS = 30;

/**
 * One agent, from the operator's side: identity (name, owner, description)
 * and the same on/off control the oversight table's "Turn off" button
 * offers, plus the usage this agent has actually run up — token spend
 * (durable, content-free) and its tool calls by connector (content, so
 * limited to failed attempts here — see agent-usage.ts).
 */
export default async function AdminAgentDetailPage({
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

  const agent = await getAgentForAdmin(db, tenant.id, agentId);
  if (!agent) notFound();

  const [tokenUsage, toolUsage] = await Promise.all([
    getAgentTokenUsage(db, tenant.id, agentId),
    getAgentToolUsage(db, tenant.id, agentId, TOOL_USAGE_WINDOW_DAYS),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <BackLink href={`/${slug}/admin/agents`} label="Agent oversight" />
        <h1 className="text-xl font-bold">{agent.name}</h1>
        <AdminAgentToggle slug={slug} agentId={agent.id} enabled={agent.enabled} />
        <Link
          href={`/${slug}/admin/agents/${agent.id}/runs`}
          className="ml-auto text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Run history
        </Link>
      </div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Owner: {agent.ownerEmail ?? agent.ownerSubject}
        {' · '}
        Last run: {agent.lastRunAt ? <LocalTime at={agent.lastRunAt} /> : <span>never</span>}
      </p>

      {agent.description ? (
        <p className="mb-6 rounded-md bg-gray-50 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {agent.description}
        </p>
      ) : agent.descriptionStatus === 'stale' ? (
        <p className="mb-6 text-sm italic text-gray-400 dark:text-gray-500">Writing a summary…</p>
      ) : null}

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <h2 className="mb-3 text-sm font-semibold">Usage</h2>
        <AgentUsagePanel
          tokens={tokenUsage}
          tools={toolUsage}
          toolWindowDays={TOOL_USAGE_WINDOW_DAYS}
        />
      </div>
    </div>
  );
}
