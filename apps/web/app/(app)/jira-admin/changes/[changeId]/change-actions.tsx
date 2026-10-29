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
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { reportFetchFailure } from '@/lib/fetch-json';

export function RefreshWhileRunning({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [running, router]);
  return null;
}

type Action = 'apply' | 'cancel';

export default function ChangeActions({
  changeId,
  count,
  applyBlocked,
  canApprove,
  isRequest = false,
  isOwner,
}: {
  changeId: string;
  /** How many operations, for the button's label. */
  count: number;
  /** Why approving is refused right now (read-only mode, not connected…); null when it is not. */
  applyBlocked: string | null;
  /** An operator: may approve and decline. Anyone else may only withdraw their own. */
  canApprove: boolean;
  /** A request in words: nothing to approve, only to build elsewhere or decline. */
  isRequest?: boolean;
  /** This is the person's own request. */
  isOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');

  async function act(action: Action) {
    setBusy(action);
    setNotice(null);
    try {
      const response = await fetch(`/api/jira-admin/changes/${changeId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'cancel' ? { note } : {}),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const body: Record<string, unknown> =
          typeof data === 'object' && data !== null ? Object.fromEntries(Object.entries(data)) : {};
        const message =
          typeof body.error === 'string' && body.error
            ? body.error
            : action === 'apply'
              ? 'Could not approve the change'
              : 'Could not cancel the change';
        reportFetchFailure(
          'POST',
          `/api/jira-admin/changes/${changeId}/${action}`,
          response.status,
          message
        );
        setNotice(message);
        return;
      }
      if (action === 'apply') setQueued(true);
      router.refresh();
    } catch (error) {
      reportFetchFailure(
        'POST',
        `/api/jira-admin/changes/${changeId}/${action}`,
        0,
        'Could not reach the server',
        error
      );
      setNotice('Could not reach the server');
    } finally {
      setBusy(null);
    }
  }

  const approveLabel =
    count === 1
      ? 'Approve and apply this change to Jira'
      : `Approve and apply these ${count} changes to Jira`;

  return (
    <div className="mt-6">
      {applyBlocked && canApprove && !isRequest && (
        <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {applyBlocked}
        </p>
      )}
      {notice && (
        <p
          role="alert"
          className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300"
        >
          {notice}
        </p>
      )}
      {queued && (
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
      {!canApprove && (
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
          An operator reviews and approves changes to Jira. You will be notified when this one is
          decided.
        </p>
      )}
      {declining && canApprove && (
        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium" htmlFor="decline-note">
            Why (the requester reads this)
          </label>
          <textarea
            id="decline-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-gray-300 bg-transparent p-2 text-sm dark:border-gray-700"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {canApprove && !isRequest && (
          <button
            onClick={() => void act('apply')}
            disabled={busy !== null || applyBlocked !== null || queued}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'apply' ? 'Approving…' : approveLabel}
          </button>
        )}
        {canApprove && !declining && (
          <button
            onClick={() => setDeclining(true)}
            disabled={busy !== null || queued}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Decline it
          </button>
        )}
        {((declining && canApprove) || (!canApprove && isOwner)) && (
          <button
            onClick={() => void act('cancel')}
            disabled={busy !== null || queued}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {busy === 'cancel' ? 'Cancelling…' : canApprove ? 'Send the decline' : 'Withdraw it'}
          </button>
        )}
      </div>
    </div>
  );
}
