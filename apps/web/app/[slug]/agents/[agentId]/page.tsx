import React from 'react';
import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { instructionPreview } from '@renkei/agents';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getAgent } from '@/lib/agents/store';

/**
 * The readable overview of one agent: the generated description (the
 * spot-check summary), any concerns it raised, the steps as sentences, and
 * where to go next (edit, runs). Actions live on the list page; this page
 * is for READING the recipe.
 */
export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ slug: string; agentId: string }>;
}): Promise<React.ReactNode> {
  const { slug, agentId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/agents/${agentId}`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const agent = await getAgent(dbResult.val, tenant.id, session.subject, agentId);
  if (!agent) notFound();

  const reviewNotes = Array.isArray(agent.reviewNotes)
    ? agent.reviewNotes.filter((note): note is string => typeof note === 'string')
    : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-bold">{agent.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              agent.enabled
                ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            }`}
          >
            {agent.enabled ? 'On' : 'Off'}
          </span>
        </div>
        <div className="flex shrink-0 gap-2 text-sm">
          <Link
            href={`/${slug}/agents/${agentId}/runs`}
            className="rounded-md border border-gray-300 px-3 py-1.5 dark:border-gray-700"
          >
            Runs
          </Link>
          <Link
            href={`/${slug}/agents/${agentId}/edit`}
            className="rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white"
          >
            Edit
          </Link>
        </div>
      </div>

      {agent.description ? (
        <p className="mb-4 rounded-md bg-gray-50 p-3 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {agent.description}
        </p>
      ) : null}

      {reviewNotes.length > 0 ? (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Worth checking
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
            {reviewNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <h2 className="mb-2 text-sm font-semibold">Steps</h2>
      <ol className="space-y-2">
        {agent.steps.steps.map((step, index) => (
          <li
            key={step.id}
            className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
          >
            <span className="mr-2 font-semibold">{index + 1}.</span>
            <span className="font-medium">{step.name}</span>
            <p className="mt-1 text-gray-600 dark:text-gray-400">
              {instructionPreview(step.instruction)}
            </p>
            {step.failureHandling.some((entry) => entry.action === 'retry') ? (
              <p className="mt-1 text-xs text-gray-500">
                Retries up to {step.maxAttempts}× on handled failures.
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
