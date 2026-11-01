'use client';

/**
 * A person's own opt-in, per pull request: watch its pipeline outcome,
 * and — once watching — auto-merge on green or auto-fix on red. Reads
 * and writes …/code/projects/[projectId]/pr-subscriptions
 * (subscriber_subject is always the signed-in person; there is no one
 * else's subscription to show here). Auto-fix posts a note into the
 * chat that pushed the PR rather than restarting the agent unattended
 * — apps/worker/src/handlers/chat-note.ts's header comment has the
 * why — so its label says exactly that, not more. What each box may
 * do, what a change sends and what a refusal leaves on screen is
 * pr-subscribe.model.ts.
 */

import { useEffect, useReducer } from 'react';
import ExternalLink from '@/components/external-link';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import {
  boxEnabled,
  initialPrSubscribe,
  prSubscribeReducer,
  saveRequest,
  shownOutcome,
  toggledSubscription,
  type Box,
  type EventView,
  type SubscriptionView,
} from './pr-subscribe.model';

export default function PrSubscribe({
  projectId,
  prNumber,
  prUrl,
  compact = false,
}: {
  projectId: string;
  prNumber: number;
  prUrl?: string;
  /** The project page's own card shows one PR at a time — a single
   * flex-wrapped row with short labels, in place of the full page's
   * stacked checkboxes, so subscribing never requires leaving the
   * project screen for the common case. */
  compact?: boolean;
}) {
  const base = `/api/code/projects/${projectId}/pr-subscriptions`;
  const [model, dispatch] = useReducer(prSubscribeReducer, initialPrSubscribe);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<{
        subscription: SubscriptionView | null;
        lastEvent: EventView | null;
      }>(`${base}?prNumber=${prNumber}`);
      if (!cancelled) {
        dispatch({
          type: 'loaded',
          subscription: result.data?.subscription ?? null,
          lastEvent: result.data?.lastEvent ?? null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, prNumber]);

  const state = model.subscription;
  const error = model.error;
  if (state === null) return null;

  const toggle = async (box: Box, checked: boolean) => {
    const request = saveRequest(prNumber, toggledSubscription(state, box, checked));
    dispatch({ type: 'toggled', box, checked });
    const result = await sendJsonFull(base, request.method, request.body);
    dispatch(result.error ? { type: 'failed', error: result.error } : { type: 'saved' });
  };
  const toggleWatch = (checked: boolean) => void toggle('watch', checked);
  const toggleAutoFix = (checked: boolean) => void toggle('fix', checked);
  const toggleAutoMerge = (checked: boolean) => void toggle('merge', checked);
  const watchEnabled = boxEnabled(model, 'watch');
  const dependentsEnabled = boxEnabled(model, 'fix');

  const line = shownOutcome(model);
  const outcome = line ? (
    <>
      {line}
      {prUrl ? (
        <>
          {' '}
          <ExternalLink href={prUrl} className="text-blue-600 hover:underline dark:text-blue-400">
            View
          </ExternalLink>
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
            disabled={!watchEnabled}
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
            disabled={!dependentsEnabled}
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
            disabled={!dependentsEnabled}
            onChange={(e) => toggleAutoMerge(e.target.checked)}
          />
          Merge
        </label>
        {outcome ? (
          <span className="w-full text-gray-500 dark:text-gray-400">{outcome}</span>
        ) : null}
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
          disabled={!watchEnabled}
          onChange={(e) => toggleWatch(e.target.checked)}
        />
        Subscribe to pipeline outcomes
      </label>
      <label
        className={`flex items-center gap-1.5 pl-5 ${state.watchPipelines ? '' : 'text-gray-400'}`}
      >
        <input
          type="checkbox"
          checked={state.autoFix}
          disabled={!dependentsEnabled}
          onChange={(e) => toggleAutoFix(e.target.checked)}
        />
        Note a failure in this chat
      </label>
      <label
        className={`flex items-center gap-1.5 pl-5 ${state.watchPipelines ? '' : 'text-gray-400'}`}
      >
        <input
          type="checkbox"
          checked={state.autoMerge}
          disabled={!dependentsEnabled}
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
