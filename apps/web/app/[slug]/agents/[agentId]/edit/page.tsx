import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent } from '@/lib/agents/store';
import { loadBuilderData } from '@/lib/agents/builder-data';
import { AgentBuilder } from '../../builder/agent-builder';

export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/${agentId}/edit`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  // Owner-scoped lookup: someone else's agent is a 404, never a hint.
  const agent = await getAgent(dbResult.val, tenant.id, session.subject, agentId);
  if (!agent) notFound();

  const data = await loadBuilderData(dbResult.val, tenant.id, session.subject, agentId);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Edit “{agent.name}”</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Changes apply to future runs — anything already queued keeps the steps it was queued with.
      </p>
      <AgentBuilder
        slug={slug}
        tenantId={tenant.id}
        tools={data.tools}
        otherAgents={data.otherAgents}
        models={data.models}
        existing={agent}
      />
    </div>
  );
}
