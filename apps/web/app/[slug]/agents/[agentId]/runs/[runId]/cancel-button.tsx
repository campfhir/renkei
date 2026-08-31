'use client';

/**
 * Stop a run that hasn't finished — queued, waiting on the owner, or
 * actively running. The click only asks (see requestRunCancellation); the
 * page keeps showing the run's last-known status until a refresh picks up
 * "canceled", so a short-lived "Canceling…" covers that gap rather than
 * implying it happened instantly.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';

export default function CancelButton({
  tenantId,
  agentId,
  runId,
}: {
  tenantId: string;
  agentId: string;
  runId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ ok: true }>(
      `/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/cancel`,
      'POST'
    );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setDone(true);
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void cancel()}
        disabled={busy || done}
        title="Stop this run — it will not go any further"
        className="rounded-md border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:border-red-500 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {done ? 'Canceling…' : busy ? 'Canceling…' : '✕ Cancel run'}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </>
  );
}
