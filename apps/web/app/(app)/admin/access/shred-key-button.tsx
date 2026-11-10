'use client';

import { useReducer } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  buttonLabel,
  confirmText,
  initialShred,
  nameConfirmed,
  promptText,
  removalOutcome,
  removeKeyPath,
  shredReducer,
} from './shred-key-button.model';

/**
 * The administrator's one irreversible act on the Access page: removing a
 * person's encryption key (docs/delegate-key-design.md, "Loss"). Everything
 * of theirs becomes unreadable, to them and to Renkei alike, so it asks
 * twice — once in words, once by typing the person's name. What it asks,
 * sends and shows is shred-key-button.model.ts's.
 */
export default function ShredKeyButton({
  subject,
  displayName,
}: {
  subject: string;
  displayName: string;
}) {
  const { refresh, pending } = useRefresh();
  const [state, dispatch] = useReducer(shredReducer, initialShred);

  async function shred() {
    if (!window.confirm(confirmText(displayName))) return;
    if (!nameConfirmed(window.prompt(promptText(displayName)), displayName)) return;
    dispatch({ type: 'sent' });
    try {
      const response = await fetch(removeKeyPath(subject), { method: 'DELETE' });
      const body: unknown = await response.json().catch(() => ({}));
      const outcome = removalOutcome(response.ok, body);
      if (!outcome.removed) {
        reportFetchFailure(
          'DELETE',
          `/api/admin/access/${subject}/keys`,
          response.status,
          outcome.error
        );
        dispatch({ type: 'refused', error: outcome.error });
        return;
      }
      dispatch({ type: 'removed' });
      refresh();
    } catch (error) {
      reportFetchFailure(
        'DELETE',
        `/api/admin/access/${subject}/keys`,
        0,
        'Could not reach the server',
        error
      );
      dispatch({ type: 'unreachable' });
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void shred()}
        disabled={state.busy || pending}
        className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
        title="Remove this person's encryption key; nothing of theirs can be read again"
        data-testid={`shred-key-${subject}`}
      >
        {buttonLabel(state)}
      </button>
      {state.error ? <span className="text-xs text-red-600">{state.error}</span> : null}
    </span>
  );
}
