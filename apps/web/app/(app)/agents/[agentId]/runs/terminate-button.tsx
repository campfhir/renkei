'use client';

/**
 * Terminate stuck runs — one (the run page) or all of an agent's (the runs
 * page). What it does on each press is terminate-button.model.ts; this
 * sends the request and refreshes the page once it lands.
 */

import { useReducer } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { sendJsonFull } from '@/lib/fetch-json';
import {
  initialTerminateState,
  terminateOutcome,
  terminateQuestion,
  terminateReducer,
} from './terminate-button.model';

const DANGER =
  'rounded-md border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:border-red-500 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40';

export default function TerminateButton({
  agentId,
  runId,
  label,
}: {
  agentId: string;
  /** One run; omit to terminate every stuck run of the agent. */
  runId?: string;
  label: string;
}) {
  const { refresh, pending } = useRefresh();
  const [state, dispatch] = useReducer(terminateReducer, initialTerminateState);
  const single = runId !== undefined;
  const outcome = terminateOutcome(state, single);

  const send = async () => {
    dispatch({ type: 'confirm' });
    const result = await sendJsonFull<{ terminated: string[] }>(
      `/api/agents/${agentId}/runs/terminate`,
      'POST',
      single ? { runId } : undefined
    );
    if (result.error || !result.data) {
      dispatch({ type: 'refused', error: result.error ?? 'Could not terminate — try again.' });
      return;
    }
    dispatch({ type: 'terminated', count: result.data.terminated.length });
    refresh();
  };

  if (state.phase === 'confirming') {
    return (
      <span
        role="group"
        aria-label="Confirm terminate"
        className="inline-flex flex-wrap items-center gap-2 text-xs"
      >
        <span className="text-gray-700 dark:text-gray-300">{terminateQuestion(single)}</span>
        <button type="button" onClick={() => void send()} className={DANGER}>
          Terminate
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: 'keep' })}
          className="rounded-md border border-gray-300 px-2 py-0.5 font-medium hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
        >
          Keep
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {state.phase !== 'done' ? (
        <button
          type="button"
          onClick={() => dispatch({ type: 'press' })}
          disabled={state.phase === 'busy' || pending}
          title="Stuck for over two hours: close it out — a cancel never reaches a stuck run"
          className={DANGER}
        >
          {state.phase === 'busy' ? 'Terminating…' : label}
        </button>
      ) : null}
      {outcome ? (
        <span
          role="status"
          className={`text-xs ${state.phase === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}
        >
          {outcome}
        </span>
      ) : null}
    </span>
  );
}
