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

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { StoredAgent } from '@/lib/agents/store';
import { sendJsonFull } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';
import { triggerBadge, triggerSummary } from '@/lib/agents/trigger-summary';
import AgentEnabledToggle from '@/components/agent-enabled-toggle';

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
  // Danger is red AT REST, matching RemoveButton. It used to be grey until
  // hovered, which tells you it deletes only once you are already pointing at
  // it — and on a touch screen, never.
  const className = `rounded-md p-1.5 transition-colors ${
    danger
      ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
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

/**
 * Trigger chips name WHAT fires the agent ("A meeting transcript is
 * ready", "Every weekday at 8:00 AM"), not just the trigger kind. Cards
 * stay one line tall: the first few fit, the rest fold into a "+n" chip
 * whose hover tooltip lists them and whose click opens the full list.
 */
const TRIGGER_CHIP_LIMIT = 2;

function TriggersDialog({ agent, onClose }: { agent: StoredAgent; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Triggers of ${agent.name}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-800 dark:bg-gray-950"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold">Triggers — {agent.name}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <ul className="mt-3 divide-y divide-gray-100 text-sm dark:divide-gray-900">
          {agent.triggers.map((trigger) => (
            <li key={trigger.id} className="flex items-baseline justify-between gap-3 py-2">
              <span className="break-words">{triggerSummary(trigger.draft)}</span>
              <span className="shrink-0 text-xs text-gray-500">
                {triggerBadge(trigger.draft.kind)}
                {!trigger.enabled ? ' · off' : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A card in the "Shared with you" group: whose it is, and until when. */
export interface SharedAgentCard {
  agent: StoredAgent;
  sharedBy: string;
  expiresAt: string | null;
}

export function AgentsList({
  slug,
  tenantId,
  agents,
  shared = [],
}: {
  slug: string;
  tenantId: string;
  agents: StoredAgent[];
  /** Someone else's agents this viewer holds access grants on. */
  shared?: SharedAgentCard[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranNow, setRanNow] = useState<string | null>(null);
  const [triggersFor, setTriggersFor] = useState<StoredAgent | null>(null);

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

  if (agents.length === 0 && shared.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        No agents yet. Draft your first one — describe steps in plain words, pick a trigger, and
        review before turning it on.
      </p>
    );
  }

  const renderCard = (agent: StoredAgent, sharedInfo?: SharedAgentCard) => {
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
          <span className="flex min-w-0 items-center gap-2">
            <Link
              href={`/${slug}/agents/${agent.id}`}
              className="truncate text-sm font-semibold hover:underline"
            >
              {agent.name}
            </Link>
            {sharedInfo ? (
              <span
                title={
                  sharedInfo.expiresAt
                    ? `Access until ${new Date(sharedInfo.expiresAt).toLocaleString()}`
                    : 'Open-ended access'
                }
                className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              >
                Shared by {sharedInfo.sharedBy}
              </span>
            ) : null}
          </span>
          <AgentEnabledToggle tenantId={tenantId} agent={agent} onError={setError} />
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
                We couldn&apos;t write a summary — check the organization&apos;s agent models, then
                save again.
              </span>
            ))
          )}
        </p>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5">
            {agent.triggers.slice(0, TRIGGER_CHIP_LIMIT).map((trigger) => {
              const summary = triggerSummary(trigger.draft);
              return (
                <span
                  key={trigger.id}
                  title={summary}
                  className="inline-block max-w-[16rem] truncate rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400"
                >
                  {summary}
                </span>
              );
            })}
            {agent.triggers.length > TRIGGER_CHIP_LIMIT ? (
              <button
                type="button"
                onClick={() => setTriggersFor(agent)}
                title={agent.triggers
                  .slice(TRIGGER_CHIP_LIMIT)
                  .map((trigger) => triggerSummary(trigger.draft))
                  .join('\n')}
                className="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                +{agent.triggers.length - TRIGGER_CHIP_LIMIT} more
              </button>
            ) : null}
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
            {!sharedInfo ? (
              <IconButton
                label="Delete"
                icon="trash"
                danger
                disabled={busy === agent.id}
                onClick={() => remove(agent)}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {agents.map((agent) => (
        <React.Fragment key={agent.id}>{renderCard(agent)}</React.Fragment>
      ))}
      {shared.length > 0 ? (
        <div className="pt-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Shared with you
          </h2>
          <div className="space-y-3">
            {shared.map((entry) => (
              <React.Fragment key={entry.agent.id}>{renderCard(entry.agent, entry)}</React.Fragment>
            ))}
          </div>
        </div>
      ) : null}
      {triggersFor ? (
        <TriggersDialog agent={triggersFor} onClose={() => setTriggersFor(null)} />
      ) : null}
    </div>
  );
}
