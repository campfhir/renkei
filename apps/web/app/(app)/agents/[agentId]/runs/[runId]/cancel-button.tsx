'use client';

/**
 * Stop a run that hasn't finished — queued, waiting on the owner, or
 * actively running. A queued run is canceled in the request; a started one
 * stops at its next checkpoint (requestRunCancellation). What the button
 * says through that is cancel-button.model.ts.
 */

import { useReducer } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { sendJsonFull } from '@/lib/fetch-json';
import { canPress, cancelLabel, cancelReducer, initialCancelState } from './cancel-button.model';

export default function CancelButton({ agentId, runId }: { agentId: string; runId: string }) {
  const { refresh, pending } = useRefresh();
  const [state, dispatch] = useReducer(cancelReducer, initialCancelState);

  const cancel = async () => {
    if (!canPress(state)) return;
    dispatch({ type: 'press' });
    const result = await sendJsonFull<{ ok: true; canceled?: boolean }>(
      `/api/agents/${agentId}/runs/${runId}/cancel`,
      'POST'
    );
    if (result.error) {
      dispatch({ type: 'refused', error: result.error });
      return;
    }
    dispatch({ type: 'answered', canceled: result.data?.canceled === true });
    refresh();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={!canPress(state) || pending}
        title="Stop this run — it will not go any further"
        className="rounded-md border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:border-red-500 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {cancelLabel(state)}
      </button>
      {state.phase === 'idle' && state.error ? (
        <span className="text-xs text-red-600 dark:text-red-400">{state.error}</span>
      ) : null}
    </>
  );
}
