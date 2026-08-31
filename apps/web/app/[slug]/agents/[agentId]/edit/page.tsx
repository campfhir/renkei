import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { loadBuilderData } from '@/lib/agents/builder-data';
import AgentEnabledToggle from '@/components/agent-enabled-toggle';
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
  // Access-scoped lookup (owner or unexpired grant): anyone else's agent
  // is a 404, never a hint.
  const access = await resolveAgentAccess(dbResult.val, tenant.id, session.subject, agentId);
  if (!access) notFound();
  const agent = access.agent;

  // Builder data resolves against the OWNER: the agent runs on the owner's
  // grants, so the tool palette, and the "call another agent" list, must
  // describe the owner's world even when a grantee is doing the editing.
  const data = await loadBuilderData(dbResult.val, tenant.id, access.ownerSubject, agentId);

  // No width cap here: the builder manages its own — it self-centers while
  // reading and goes two-column (canvas + editor panel) on selection.
  return (
    <div>
      <div className="mx-auto mb-6 lg:max-w-3xl">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">Edit “{agent.name}”</h1>
          {access.viewerIsOwner ? (
            <AgentEnabledToggle tenantId={tenant.id} agent={agent} />
          ) : (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                agent.enabled
                  ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
              }`}
            >
              {agent.enabled ? 'On' : 'Off'}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Changes apply to future runs — anything already queued keeps the steps it was queued with.
        </p>
      </div>
      <AgentBuilder
        slug={slug}
        tenantId={tenant.id}
        tools={data.tools}
        otherAgents={data.otherAgents}
        calendars={data.calendars}
        models={data.models}
        attemptsCap={data.attemptsCap}
        maxSteps={data.maxSteps}
        existing={agent}
      />
    </div>
  );
}
