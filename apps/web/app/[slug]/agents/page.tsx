import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAgents } from '@/lib/agents/store';
import { AgentsList } from './agents-list';

/**
 * Your agents — every signed-in user's own list (agents are per-user
 * creations acting on their own grants; the org-wide view is the admin's
 * oversight page).
 */
export default async function AgentsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents`));
  }

  const dbResult = getDatabase();
  const agents = dbResult.ok ? await listAgents(dbResult.val, tenant.id, session.subject) : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="mb-1 text-xl font-bold">Agents</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Step-by-step helpers you draft yourself — they act with your own connections, on your
            triggers, and keep a full history of every run.
          </p>
        </div>
        <Link
          href={`/${slug}/agents/new`}
          className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white"
        >
          New agent
        </Link>
      </div>
      <AgentsList slug={slug} tenantId={tenant.id} agents={agents} />
    </div>
  );
}
