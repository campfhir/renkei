'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The decision controls of an APPROVAL card — the human half of a paused
 * agent run. Approve/decline in 'approve' mode; a typed answer plus "I
 * don't know" in 'input' mode. There is deliberately no dismiss: a
 * dismissed card would leave the run waiting on a decision nobody can see
 * anymore — declining is the "no", and doing nothing lets the wait run out
 * onto the flow's timed-out path.
 *
 * Both modes send the same `decision: 'decline'`; only the WORD differs,
 * and it has to. "Stop the run" is what the second button used to say in
 * input mode, and it described something that does not happen: declining
 * routes the node's declined path like any other outcome, and where that
 * path is empty the run simply carries on. What the person means by
 * pressing it is "I have no answer" — so that is what it says.
 *
 * A 502 still refreshes: the decision is durably recorded and the worker's
 * sweep resumes the run on its own — the warning is about latency, not loss.
 */
export default function ApprovalActions({
  tenantId,
  itemId,
  mode,
}: {
  tenantId: string;
  itemId: string;
  mode: 'approve' | 'input';
}): React.ReactNode {
  const router = useRouter();
  const [answer, setAnswer] = useState('');
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
        body: JSON.stringify(
          decision === 'approve' && mode === 'input'
            ? { decision, answer: answer.trim() }
            : { decision }
        ),
      });
      const body: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof body === 'object' && body !== null ? { ...body } : {};
      if (response.status === 502 && typeof record.warning === 'string') {
        setNotice(record.warning);
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError(
          typeof record.error === 'string' ? record.error : `Request failed (${response.status})`
        );
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {mode === 'input' ? (
        <>
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={3}
            maxLength={10_000}
            placeholder="Type your answer — the run continues with it"
            aria-label="Your answer"
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void decide('approve')}
              disabled={busy || answer.trim().length === 0}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Send the answer
            </button>
            <button
              onClick={() => void decide('decline')}
              disabled={busy}
              title="Send no answer — the run continues down the path its author wrote for that."
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
            >
              I don&apos;t know
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void decide('approve')}
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => void decide('decline')}
            disabled={busy}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
          >
            Decline
          </button>
        </div>
      )}
      {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}
