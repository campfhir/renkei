'use client';

import React, { useState } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { reportFetchFailure } from '@/lib/fetch-json';

/**
 * The decision controls of an APPROVAL card — a batch of actions an agent
 * staged, waiting on a person. Accept hands the whole batch to the action
 * executor, which makes the calls in order and reports each outcome back
 * to the agent; decline makes none of them. Either may carry a short
 * comment the agent reads with the outcome ("not this project — use OPS").
 *
 * There is deliberately no dismiss: a dismissed card would leave the run
 * waiting on a decision nobody can see anymore — declining is the "no",
 * and doing nothing lets the wait run out (none of the actions are made).
 *
 * A 502 still refreshes: the decision is durably recorded and the
 * worker's sweep resumes the run on its own — the warning is about
 * latency, not loss.
 */
export default function ApprovalActions({
  itemId,
}: {
  itemId: string;
}): React.ReactNode {
  const { refresh, pending } = useRefresh();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'decline'): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/actionable-items/${itemId}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment: comment.trim() }),
      });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (response.status === 502 && typeof record.warning === 'string') {
        reportFetchFailure(
          'POST',
          `/api/actionable-items/${itemId}/approval`,
          response.status,
          record.warning
        );
        setNotice(record.warning);
        refresh();
        return;
      }
      if (!response.ok) {
        const message =
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`;
        reportFetchFailure(
          'POST',
          `/api/actionable-items/${itemId}/approval`,
          response.status,
          message
        );
        setError(message);
        return;
      }
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        rows={2}
        maxLength={10_000}
        placeholder="Add a note for the agent (optional)"
        aria-label="Comment"
        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void decide('approve')}
          disabled={busy || pending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Accept
        </button>
        <button
          onClick={() => void decide('decline')}
          disabled={busy || pending}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
        >
          Decline
        </button>
      </div>
      {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
