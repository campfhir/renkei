'use client';

/**
 * The agents list with its inline actions — on/off, run now, delete.
 * Deleting removes the run history with it (the owner's own call), so the
 * confirm says so in words rather than assuming.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { StoredAgent } from '@/lib/agents/store';
import { sendJsonFull } from '@/lib/fetch-json';

function triggerBadge(kind: string): string {
  switch (kind) {
    case 'event':
      return 'On an event';
    case 'schedule':
      return 'Scheduled';
    case 'agent':
      return 'After an agent';
    case 'api':
      return 'API';
    default:
      return kind;
  }
}

export function AgentsList({
  slug,
  tenantId,
  agents,
}: {
  slug: string;
  tenantId: string;
  agents: StoredAgent[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (agent: StoredAgent) => {
    setBusy(agent.id);
    setError(null);
    const result = await sendJsonFull(`/api/tenant/${tenantId}/agents/${agent.id}`, 'PUT', {
      name: agent.name,
      steps: agent.steps,
      triggers: agent.triggers.map((trigger) => ({
        id: trigger.id,
        draft: trigger.draft,
        enabled: trigger.enabled,
      })),
      enabled: !agent.enabled,
      llmModelId: agent.llmModelId,
    });
    setBusy(null);
    if (result.error) setError(result.error);
    else router.refresh();
  };

  const runNow = async (agent: StoredAgent) => {
    setBusy(agent.id);
    setError(null);
    const result = await sendJsonFull(`/api/tenant/${tenantId}/agents/${agent.id}/invoke`, 'POST');
    setBusy(null);
    if (result.error) setError(result.error);
    else router.refresh();
  };

  const remove = async (agent: StoredAgent) => {
    if (
      !window.confirm(
        `Delete “${agent.name}”? Its run history is deleted with it. This cannot be undone.`
      )
    ) {
      return;
    }
    setBusy(agent.id);
    setError(null);
    const result = await sendJsonFull(`/api/tenant/${tenantId}/agents/${agent.id}`, 'DELETE');
    setBusy(null);
    if (result.error) setError(result.error);
    else router.refresh();
  };

  if (agents.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        No agents yet. Draft your first one — describe steps in plain words, pick a trigger, and
        review before turning it on.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {agents.map((agent) => (
        <div
          key={agent.id}
          className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link
                href={`/${slug}/agents/${agent.id}`}
                className="text-sm font-semibold hover:underline"
              >
                {agent.name}
              </Link>
              {agent.description ? (
                <p className="mt-0.5 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
                  {agent.description}
                </p>
              ) : null}
              <p className="mt-1.5 flex flex-wrap gap-1.5">
                {agent.triggers.map((trigger) => (
                  <span
                    key={trigger.id}
                    className="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400"
                  >
                    {triggerBadge(trigger.draft.kind)}
                  </span>
                ))}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <button
              type="button"
              disabled={busy === agent.id}
              onClick={() => toggle(agent)}
              className="font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              {agent.enabled ? 'Turn off' : 'Turn on'}
            </button>
            <button
              type="button"
              disabled={busy === agent.id}
              onClick={() => runNow(agent)}
              className="font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              Run now
            </button>
            <Link
              href={`/${slug}/agents/${agent.id}/edit`}
              className="font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Edit
            </Link>
            <Link
              href={`/${slug}/agents/${agent.id}/runs`}
              className="font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Runs
            </Link>
            <button
              type="button"
              disabled={busy === agent.id}
              onClick={() => remove(agent)}
              className="font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
