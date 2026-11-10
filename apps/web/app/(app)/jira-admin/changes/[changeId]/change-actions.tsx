'use client';

/**
 * Approve, Decline and Withdraw on a Jira admin change request's
 * review page — the click the confirm rule is about. All post to
 * session-only routes that act on the stored request by id; nothing about
 * the change travels from here.
 *
 * Approving only queues the change: the route answers at once and the
 * deploy runs on the server, so the button goes back to normal after a
 * moment and the page shows the job's progress (and keeps showing it if the
 * operator leaves and comes back). While anything is validating, queued or
 * deploying, the page refreshes itself every few seconds.
 *
 * What it shows and sends is change-actions.model.ts; this posts and
 * dispatches.
 */

import { useEffect, useReducer } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  actionUrl,
  changeActionsReducer,
  changeActionsView,
  failureMessage,
  initialChangeActions,
  requestBody,
  type ChangeAction,
  type ChangeActionsProps,
} from './change-actions.model';

export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [running, router]);
  return null;
}

export default function ChangeActions({
  changeId,
  ...props
}: ChangeActionsProps & { changeId: string }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(changeActionsReducer, initialChangeActions);
  const view = changeActionsView(props, state);

  async function act(action: ChangeAction) {
    const url = actionUrl(changeId, action);
    dispatch({ type: 'sent', action });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody(action, state)),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = failureMessage(action, data);
        reportFetchFailure('POST', url, response.status, message);
        dispatch({ type: 'failed', message });
        return;
      }
      dispatch({ type: 'succeeded', action });
      router.refresh();
    } catch (error) {
      reportFetchFailure('POST', url, 0, 'Could not reach the server', error);
      dispatch({ type: 'failed', message: 'Could not reach the server' });
    }
  }

  return (
    <div className="mt-6">
      {view.blocked && (
        <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {view.blocked}
        </p>
      )}
      {state.notice && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {state.notice}
        </p>
      )}
      {state.queued && (
        <p
          role="status"
          data-testid="change-queued"
          className="mb-3 rounded-md bg-blue-50 p-2 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-200"
        >
          Approved. It is queued and runs on the server — you can leave this page; you will be
          notified when it finishes.{' '}
          <Link href="/jira-admin/changes" className="font-medium underline">
            See all change requests
          </Link>
        </p>
      )}
      {view.waitsForOperator && (
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          An operator reviews and approves changes to Jira. You will be notified when this one is
          decided.
        </p>
      )}
      {view.noteField && (
        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium" htmlFor="decline-note">
            Why (the requester reads this)
          </label>
          <textarea
            id="decline-note"
            value={state.note}
            onChange={(event) => dispatch({ type: 'noteChanged', note: event.target.value })}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-gray-300 bg-transparent p-2 text-sm dark:border-gray-700"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {view.approve && (
          <button
            onClick={() => void act('apply')}
            disabled={view.approve.disabled}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {view.approve.label}
          </button>
        )}
        {view.decline && (
          <button
            onClick={() => dispatch({ type: 'startDecline' })}
            disabled={view.decline.disabled}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Decline it
          </button>
        )}
        {view.send && (
          <button
            onClick={() => void act('cancel')}
            disabled={view.send.disabled}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {view.send.label}
          </button>
        )}
      </div>
    </div>
  );
}
