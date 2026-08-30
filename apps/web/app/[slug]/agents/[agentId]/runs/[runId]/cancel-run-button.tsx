'use client';

/**
 * Stop a run that hasn't finished. A queued or waiting run stops the
 * moment this is confirmed — status flips straight to "Canceled". A
 * running run can't stop mid-step, so it's asked instead: the engine
 * notices at its next step boundary, usually within moments, and the page
 * needs a manual refresh to catch up (this app doesn't poll).
 *
 * Confirmed with a modal rather than inline, unlike Archive (reversible) —
 * this ends a run outright, and a click meant for "Run again" landing here
 * instead should not go through unchecked.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import Modal from '@/components/modal';

const dangerButton =
  'rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50';
const secondaryButton =
  'rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900';

interface CancelResponse {
  outcome?: 'canceled' | 'cancel-requested';
}

export default function CancelRunButton({
  tenantId,
  agentId,
  runId,
  status,
}: {
  tenantId: string;
  agentId: string;
  runId: string;
  status: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<CancelResponse>(
      `/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/cancel`,
      'POST'
    );
    setBusy(false);
    setConfirming(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.data?.outcome === 'cancel-requested') {
      setRequested(true);
    }
    router.refresh();
  };

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy || requested}
        onClick={() => setConfirming(true)}
        title={
          status === 'running'
            ? 'Ask this run to stop at its next step'
            : 'Cancel this run before it starts'
        }
        className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:border-red-500 hover:text-red-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-red-400 dark:hover:text-red-300"
      >
        {status === 'running' ? 'Stop run' : 'Cancel run'}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      {requested ? (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Stopping — refresh in a moment to see it finish.
        </span>
      ) : null}

      {confirming ? (
        <Modal title="Stop this run?" onClose={() => setConfirming(false)}>
          <p className="text-sm">
            {status === 'running'
              ? 'This run is in progress. It will stop at its next step rather than mid-tool-call, so it may take a few seconds.'
              : status === 'waiting'
                ? 'This run is waiting on an approval. Canceling expires that card — nobody will be able to answer it.'
                : 'This run has not started yet. Canceling removes it from the queue.'}{' '}
            This cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} className={secondaryButton}>
              Keep it running
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancel()}
              className={dangerButton}
            >
              {status === 'running' ? 'Stop run' : 'Cancel run'}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
