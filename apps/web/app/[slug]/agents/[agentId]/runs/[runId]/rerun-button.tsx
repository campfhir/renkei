'use client';

/**
 * "Run again" on a finished run: the same triggering input, put back
 * through the agent AS IT STANDS NOW. That is the whole point — you read
 * the failure, fixed the steps, and want this message retried against the
 * corrected agent — so the label says "current steps" rather than "retry",
 * which would imply replaying the version that just failed.
 *
 * Navigates to the NEW run, because the thing the user wants to watch next
 * is the one that is about to happen.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';

export default function RerunButton({
  tenantId,
  slug,
  agentId,
  runId,
}: {
  tenantId: string;
  slug: string;
  agentId: string;
  runId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rerun = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ runId: string }>(
      `/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/rerun`,
      'POST'
    );
    if (result.error || !result.data?.runId) {
      setError(result.error ?? 'The run could not be started.');
      setBusy(false);
      return;
    }
    router.push(`/${slug}/agents/${agentId}/runs/${result.data.runId}`);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void rerun()}
        disabled={busy}
        title="Start a new run on the same input, using the agent's current steps"
        className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:border-blue-500 hover:text-blue-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-blue-400 dark:hover:text-blue-300"
      >
        {busy ? 'Starting…' : '↻ Run again with current steps'}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </>
  );
}
