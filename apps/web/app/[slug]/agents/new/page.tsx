import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadBuilderData } from '@/lib/agents/builder-data';
import { AgentBuilder } from '../builder/agent-builder';

export default async function NewAgentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/new`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const data = await loadBuilderData(dbResult.val, tenant.id, session.subject);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">New agent</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Describe each step in plain words. Type <code>/</code> in a step to add a skill or a detail;
        each step can use one skill.
      </p>
      <AgentBuilder
        slug={slug}
        tenantId={tenant.id}
        tools={data.tools}
        otherAgents={data.otherAgents}
        models={data.models}
        attemptsCap={data.attemptsCap}
      />
    </div>
  );
}
