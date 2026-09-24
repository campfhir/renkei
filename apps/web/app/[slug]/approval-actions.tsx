'use client';

import React, { useState } from 'react';
import { useRefresh } from '@/lib/use-refresh';

/**
 * The decision controls of an APPROVAL card — a `needsApproval` step's
 * proposed tool call, waiting on a person. Approve fires the recorded
 * call for real, on the engine's own next turn; decline skips it. Either
 * may carry a short comment, bound as `approval.comment` for the run to
 * read (e.g. a recovery path that reads back WHY it was declined).
 *
 * There is deliberately no dismiss: a dismissed card would leave the run
 * waiting on a decision nobody can see anymore — declining is the "no",
 * and doing nothing lets the wait run out onto the timed-out treatment.
 *
 * A 502 still refreshes: the decision is durably recorded and the
 * worker's sweep resumes the run on its own — the warning is about
 * latency, not loss.
 *
 * `hideApprove`: a widget-hosted card (ApprovalWidgetCard) has its own
 * Confirm button, which can carry an edited summary/description — a second,
 * unedited Approve button next to it would just be a second, confusing way
 * to do the same thing. The widget has no way to signal a decline, though
 * (its own Cancel is local-only), so Decline — and the comment box — stay
 * here regardless.
 */
export default function ApprovalActions({
  tenantId,
  itemId,
  hideApprove = false,
}: {
  tenantId: string;
  itemId: string;
  hideApprove?: boolean;
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
      const response = await fetch(`/api/tenant/${tenantId}/actionable-items/${itemId}/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment: comment.trim() }),
      });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (response.status === 502 && typeof record.warning === 'string') {
        setNotice(record.warning);
        refresh();
        return;
      }
      if (!response.ok) {
        setError(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
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
        placeholder="Add a comment (optional)"
        aria-label="Comment"
        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        {!hideApprove && (
          <button
            onClick={() => void decide('approve')}
            disabled={busy || pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Approve
          </button>
        )}
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
