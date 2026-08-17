'use client';

/**
 * The agents list. Each card reads as a sentence about the agent: name and
 * an on/off switch up top, the GENERATED description (the save-time
 * summary — the owner's spot-check) as the body, triggers and icon actions
 * along the foot.
 *
 * "Run now" hides on agents whose only triggers are events: running one
 * without its event means every trigger.* detail is unbound, which is a
 * confusing failure, not a test. Delete confirms — it takes the run
 * history with it.
 */

import { useEffect, useRef, useState } from 'react';
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

/** Hand-rolled 16px stroke icons — the repo carries no icon dependency. */
function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-4 w-4'}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  play: 'M8 5.5v13l11-6.5z',
  pencil: 'M17 3l4 4L8 20l-5 1 1-5zM15 5l4 4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};

function IconButton({
  label,
  icon,
  onClick,
  href,
  disabled,
  danger,
}: {
  label: string;
  icon: keyof typeof ICONS;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  const className = `rounded-md p-1.5 transition-colors ${
    danger
      ? 'text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950'
      : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200'
  } ${disabled ? 'pointer-events-none opacity-40' : ''}`;
  if (href) {
    return (
      <Link href={href} aria-label={label} title={label} className={className}>
        <Icon path={ICONS[icon]} />
      </Link>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={className}
    >
      <Icon path={ICONS[icon]} />
    </button>
  );
}

function Toggle({ on, busy, onToggle }: { on: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? 'Turn agent off' : 'Turn agent on'}
      title={on ? 'On — click to turn off' : 'Off — click to turn on'}
      disabled={busy}
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'
      }`}
    >
      <span
        className={`inline-block transform rounded-full bg-white shadow transition-transform ${
          on ? 'translate-x-6' : 'translate-x-1'
        }`}
        style={{ height: '1.125rem', width: '1.125rem' }}
      />
    </button>
  );
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
  const [ranNow, setRanNow] = useState<string | null>(null);

  // Summaries are written after the save response; while any card is still
  // waiting on one, refresh the server-rendered list a few times so the
  // spinner resolves without a manual reload. Bounded — a generation that
  // died mid-flight must not turn this page into a refresh loop.
  const staleRefreshes = useRef(0);
  const anyStale = agents.some((agent) => agent.descriptionStatus === 'stale');
  useEffect(() => {
    if (!anyStale || staleRefreshes.current >= 20) return;
    const timer = setTimeout(() => {
      staleRefreshes.current += 1;
      router.refresh();
    }, 3_000);
    return () => clearTimeout(timer);
  }, [anyStale, agents, router]);

  const savePayloadOf = (agent: StoredAgent, enabled: boolean) => ({
    name: agent.name,
    steps: agent.steps,
    triggers: agent.triggers.map((trigger) => ({
      id: trigger.id,
      draft: trigger.draft,
      enabled: trigger.enabled,
    })),
    enabled,
    llmModelId: agent.llmModelId,
  });

  const toggle = async (agent: StoredAgent) => {
    setBusy(agent.id);
    setError(null);
    const result = await sendJsonFull(
      `/api/tenant/${tenantId}/agents/${agent.id}`,
      'PUT',
      savePayloadOf(agent, !agent.enabled)
    );
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
    else {
      setRanNow(agent.id);
      setTimeout(() => setRanNow(null), 4000);
    }
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
      {agents.map((agent) => {
        // Manual runs of an event agent start with its trigger.* details
        // unbound — not a useful test, so the button isn't offered.
        const eventOnly =
          agent.triggers.length > 0 &&
          agent.triggers.every((trigger) => trigger.draft.kind === 'event');
        return (
          <div
            key={agent.id}
            className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="flex items-center justify-between gap-3">
              <Link
                href={`/${slug}/agents/${agent.id}`}
                className="truncate text-sm font-semibold hover:underline"
              >
                {agent.name}
              </Link>
              <Toggle on={agent.enabled} busy={busy === agent.id} onToggle={() => toggle(agent)} />
            </div>

            <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400">
              {agent.descriptionStatus === 'stale' ? (
                <span className="flex items-center gap-2 italic text-gray-400 dark:text-gray-500">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 dark:border-gray-700 dark:border-t-blue-400"
                  />
                  Writing a summary…
                </span>
              ) : (
                (agent.description ?? (
                  <span className="italic text-gray-400 dark:text-gray-500">
                    We couldn&apos;t write a summary — check the organization&apos;s agent models,
                    then save again.
                  </span>
                ))
              )}
            </p>

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="flex min-w-0 flex-wrap gap-1.5">
                {agent.triggers.map((trigger) => (
                  <span
                    key={trigger.id}
                    className="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400"
                  >
                    {triggerBadge(trigger.draft.kind)}
                  </span>
                ))}
                {ranNow === agent.id ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                    Run started
                  </span>
                ) : null}
              </p>
              <div className="flex shrink-0 items-center gap-0.5">
                {!eventOnly ? (
                  <IconButton
                    label="Run now"
                    icon="play"
                    disabled={busy === agent.id}
                    onClick={() => runNow(agent)}
                  />
                ) : null}
                <IconButton label="Edit" icon="pencil" href={`/${slug}/agents/${agent.id}/edit`} />
                <IconButton
                  label="Run history"
                  icon="clock"
                  href={`/${slug}/agents/${agent.id}/runs`}
                />
                <IconButton
                  label="Delete"
                  icon="trash"
                  danger
                  disabled={busy === agent.id}
                  onClick={() => remove(agent)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
