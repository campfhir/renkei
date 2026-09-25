'use client';

/**
 * A person's own opt-in, per pull request: watch its pipeline outcome,
 * and — once watching — auto-merge on green or auto-fix on red. Reads
 * and writes …/code/projects/[projectId]/pr-subscriptions
 * (subscriber_subject is always the signed-in person; there is no one
 * else's subscription to show here). Auto-fix posts a note into the
 * chat that pushed the PR rather than restarting the agent unattended
 * — apps/worker/src/handlers/chat-note.ts's header comment has the
 * why — so its label says exactly that, not more.
 */

import { useEffect, useState } from 'react';
import { getJson, sendJsonFull } from '@/lib/fetch-json';

interface SubscriptionView {
  watchPipelines: boolean;
  autoFix: boolean;
  autoMerge: boolean;
}

interface EventView {
  conclusion: string;
  actionTaken: string | null;
  observedAt: string;
}

const NONE: SubscriptionView = { watchPipelines: false, autoFix: false, autoMerge: false };

/** The plan's own copy for each (conclusion, action taken) pair it names. */
function outcomeLine(event: EventView): string {
  if (event.conclusion === 'success') {
    if (event.actionTaken === 'merged') return 'Pipeline succeeded — merged automatically.';
    if (event.actionTaken === 'merge_failed')
      return 'Pipeline succeeded, but the automatic merge failed.';
    return 'Pipeline succeeded.';
  }
  if (event.conclusion === 'failure') {
    if (event.actionTaken === 'fix_started')
      return 'Pipeline failed — a fix attempt was started in this chat.';
    if (event.actionTaken === 'fix_failed')
      return 'Pipeline failed, and the chat note could not be posted.';
    return 'Pipeline failed.';
  }
  if (event.conclusion === 'running') return 'Pipeline is running.';
  if (event.conclusion === 'pending') return 'Pipeline is pending.';
  return 'Pipeline outcome unclear.';
}

export default function PrSubscribe({
  tenantId,
  projectId,
  prNumber,
  prUrl,
  compact = false,
}: {
  tenantId: string;
  projectId: string;
  prNumber: number;
  prUrl?: string;
  /** The project page's own card shows one PR at a time — a single
   * flex-wrapped row with short labels, in place of the full page's
   * stacked checkboxes, so subscribing never requires leaving the
   * project screen for the common case. */
  compact?: boolean;
}) {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/pr-subscriptions`;
  const [state, setState] = useState<SubscriptionView | null>(null);
  const [lastEvent, setLastEvent] = useState<EventView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<{
        subscription: SubscriptionView | null;
        lastEvent: EventView | null;
      }>(`${base}?prNumber=${prNumber}`);
      if (!cancelled) {
        setState(result.data?.subscription ?? NONE);
        setLastEvent(result.data?.lastEvent ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, prNumber]);

  const save = async (next: SubscriptionView) => {
    setState(next);
    setBusy(true);
    setError(null);
    const result = next.watchPipelines
      ? await sendJsonFull<{ subscription: SubscriptionView }>(base, 'POST', {
          prNumber,
          watchPipelines: next.watchPipelines,
          autoFix: next.autoFix,
          autoMerge: next.autoMerge,
        })
      : await sendJsonFull(base, 'DELETE', { prNumber });
    setBusy(false);
    if (result.error) setError(result.error);
    else if (!next.watchPipelines) setLastEvent(null);
  };

  if (state === null) return null;

  const toggleWatch = (checked: boolean) =>
    void save({
      ...state,
      watchPipelines: checked,
      ...(checked ? {} : { autoFix: false, autoMerge: false }),
    });
  const toggleAutoFix = (checked: boolean) => void save({ ...state, autoFix: checked });
  const toggleAutoMerge = (checked: boolean) => void save({ ...state, autoMerge: checked });

  const outcome =
    state.watchPipelines && lastEvent ? (
      <>
        {outcomeLine(lastEvent)}
        {prUrl ? (
          <>
            {' '}
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              View
            </a>
          </>
        ) : null}
      </>
    ) : null;

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
        <label
          className="flex items-center gap-1.5"
          title="Subscribe to this pull request's pipeline outcomes"
        >
          <input
            type="checkbox"
            checked={state.watchPipelines}
            disabled={busy}
            onChange={(e) => toggleWatch(e.target.checked)}
          />
          Subscribe
        </label>
        <label
          className={`flex items-center gap-1.5 ${state.watchPipelines ? '' : 'text-gray-400'}`}
          title="Note a failure in this chat"
        >
          <input
            type="checkbox"
            checked={state.autoFix}
            disabled={busy || !state.watchPipelines}
            onChange={(e) => toggleAutoFix(e.target.checked)}
          />
          Fix
        </label>
        <label
          className={`flex items-center gap-1.5 ${state.watchPipelines ? '' : 'text-gray-400'}`}
          title="Merge automatically on success"
        >
          <input
            type="checkbox"
            checked={state.autoMerge}
            disabled={busy || !state.watchPipelines}
            onChange={(e) => toggleAutoMerge(e.target.checked)}
          />
          Merge
        </label>
        {outcome ? <span className="w-full text-gray-500 dark:text-gray-400">{outcome}</span> : null}
        {error ? (
          <span role="alert" className="w-full text-red-600 dark:text-red-400">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1 text-xs">
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={state.watchPipelines}
          disabled={busy}
          onChange={(e) => toggleWatch(e.target.checked)}
        />
        Subscribe to pipeline outcomes
      </label>
      <label className={`flex items-center gap-1.5 pl-5 ${state.watchPipelines ? '' : 'text-gray-400'}`}>
        <input
          type="checkbox"
          checked={state.autoFix}
          disabled={busy || !state.watchPipelines}
          onChange={(e) => toggleAutoFix(e.target.checked)}
        />
        Note a failure in this chat
      </label>
      <label className={`flex items-center gap-1.5 pl-5 ${state.watchPipelines ? '' : 'text-gray-400'}`}>
        <input
          type="checkbox"
          checked={state.autoMerge}
          disabled={busy || !state.watchPipelines}
          onChange={(e) => toggleAutoMerge(e.target.checked)}
        />
        Merge automatically on success
      </label>
      {outcome ? <p className="pl-5 text-gray-500 dark:text-gray-400">{outcome}</p> : null}
      {error ? (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
