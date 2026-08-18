import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { describeSchedule, flattenActionSteps, triggerEventById } from '@renkei/agents';
import type { TriggerDraft } from '@renkei/agents';
import StepsOutline from '../../[agentId]/steps-outline';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgentByShareToken } from '@/lib/agents/store';
import CopyAgentButton from './copy-agent-button';

/**
 * A shared agent, seen through its copy link: a read-only preview of the
 * configuration and one button — "Copy to my agents". Requires a session
 * in the tenant; the link alone opens nothing for outsiders. An invalid
 * or revoked token is a plain 404, indistinguishable from a link that
 * never existed.
 */
function triggerSummary(draft: TriggerDraft): string {
  switch (draft.kind) {
    case 'event':
      return triggerEventById(draft.eventId)?.label ?? draft.eventId;
    case 'schedule':
      return describeSchedule(draft);
    case 'api':
      return 'From an API call (a new key is created for your copy)';
    case 'agent':
      return 'After another agent (not copied — it points at the sharer’s agents)';
  }
}

export default async function SharedAgentPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}): Promise<React.ReactNode> {
  const { slug, token } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/shared/${token}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const agent = await getAgentByShareToken(dbResult.val, tenant.id, token);
  if (!agent) notFound();

  const tools = [
    ...new Set(
      flattenActionSteps(agent.steps.steps).flatMap((step) => (step.tool ? [step.tool] : []))
    ),
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Shared agent
      </p>
      <div className="mb-4 flex items-start justify-between gap-3">
        <h1 className="text-xl font-bold">{agent.name}</h1>
        <CopyAgentButton slug={slug} tenantId={tenant.id} token={token} />
      </div>

      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Copying makes this configuration your own: a new, switched-off agent under your account,
        running on your connections. Its knowledge notes come along; its memory starts empty.
      </p>

      {agent.description ? (
        <p className="mb-4 rounded-md bg-gray-50 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {agent.description}
        </p>
      ) : null}

      <h2 className="mb-2 text-sm font-semibold">Triggers</h2>
      {agent.triggers.length === 0 ? (
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">None configured.</p>
      ) : (
        <ul className="mb-4 space-y-1">
          {agent.triggers.map((trigger) => (
            <li
              key={trigger.id}
              className="rounded-md border border-gray-200 px-3 py-1.5 text-sm dark:border-gray-800"
            >
              {triggerSummary(trigger.draft)}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-2 text-sm font-semibold">Steps</h2>
      <div className="mb-4">
        <StepsOutline doc={agent.steps} />
      </div>

      {tools.length > 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Uses: {tools.join(', ')} — steps whose connections you haven&apos;t linked will fail until
          you connect them.
        </p>
      ) : null}
    </div>
  );
}
