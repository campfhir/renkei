'use client';

/**
 * The confirm-then-disconnect control every OAuth-style connect card ends
 * with: a plain button that turns into a "yes / keep it" pair, a DELETE call,
 * and a refresh on success. This was six near-identical copies of the same
 * three-state widget (Jira, JSM, Confluence, Bitbucket, Zoom, GitHub,
 * Microsoft, WebEx); the only things that differ between them are the
 * endpoint, the button/confirm copy, and — for Jira's `/api/mcp/...` route —
 * how the error message is shaped.
 *
 * Owns its own error notice, shown right under its own buttons rather than
 * lifted to the top of the card: a failed disconnect and the control that
 * caused it belong together. Its states and what a refusal shows are
 * disconnect-control.model.ts's.
 */

import { useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  UNREACHABLE,
  confirmLabel,
  disconnectReducer,
  disconnectRefusal,
  initialDisconnectState,
} from './disconnect-control.model';

export default function DisconnectControl({
  endpoint,
  confirmText,
  buttonLabel,
  errorFields = ['error'],
}: {
  /** DELETE endpoint that revokes the grant. */
  endpoint: string;
  /** The sentence shown once "Disconnect" is clicked, asking to confirm. */
  confirmText: React.ReactNode;
  /** Label on the initial button, e.g. "Disconnect Zoom". */
  buttonLabel: string;
  /**
   * The fields of a failed response body that carry its message, tried in
   * order. Data rather than a parse function: the cards that render this
   * are server components, and a function cannot cross into a client
   * component — passing one failed the whole connectors page.
   */
  errorFields?: readonly string[];
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(disconnectReducer, initialDisconnectState);

  async function disconnect() {
    dispatch({ type: 'sent' });
    try {
      const response = await fetch(endpoint, { method: 'DELETE' });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const notice = disconnectRefusal(data, errorFields);
        reportFetchFailure('DELETE', endpoint, response.status, notice);
        dispatch({ type: 'failed', notice });
        return;
      }
      dispatch({ type: 'disconnected' });
      router.refresh();
    } catch (error) {
      reportFetchFailure('DELETE', endpoint, 0, UNREACHABLE, error);
      dispatch({ type: 'failed', notice: UNREACHABLE });
    }
  }

  return (
    <>
      {state.notice && (
        <p className="mt-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{state.notice}</p>
      )}
      {state.confirming ? (
        <div className="mt-3 rounded-lg border border-red-300 p-3 dark:border-red-800">
          <p className="mb-3 text-sm">{confirmText}</p>
          <div className="flex gap-3">
            <button
              onClick={() => void disconnect()}
              disabled={state.busy}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {confirmLabel(state)}
            </button>
            <button
              onClick={() => dispatch({ type: 'kept' })}
              disabled={state.busy}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => dispatch({ type: 'asked' })}
          className="mt-3 rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
        >
          {buttonLabel}
        </button>
      )}
    </>
  );
}
