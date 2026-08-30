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
 *
 * A DIFFERENT run of this agent may still be live — the queue's ordering
 * key already runs one agent's jobs strictly serial, so this one just
 * waits its turn — but pressing "Run again" is easy to do without noticing
 * another run is already going, so the server asks first (409
 * `ALREADY_RUNNING`), same as the overview page's "Run now" button.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import Modal from '@/components/modal';

interface RerunResponse {
  runId?: string;
  code?: string;
  liveRun?: { id: string; status: string };
}

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
  const [pendingLiveRun, setPendingLiveRun] = useState<{ id: string; status: string } | null>(null);

  const rerun = async (confirmQueue = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<RerunResponse>(
      `/api/tenant/${tenantId}/agents/${agentId}/runs/${runId}/rerun`,
      'POST',
      confirmQueue ? { confirmQueue: true } : undefined
    );
    setBusy(false);
    if (result.error || !result.data?.runId) {
      if (result.data?.code === 'ALREADY_RUNNING' && result.data.liveRun) {
        setPendingLiveRun(result.data.liveRun);
        return;
      }
      setError(result.error ?? 'The run could not be started.');
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

      {pendingLiveRun ? (
        <Modal title="A run is already in progress" onClose={() => setPendingLiveRun(null)}>
          <p className="text-sm">
            This agent already has a run that&rsquo;s {pendingLiveRun.status} — they won&rsquo;t run
            at the same time. Starting another queues it right behind the current one.
          </p>
          <p className="mt-2 text-sm">
            <Link
              href={`/${slug}/agents/${agentId}/runs/${pendingLiveRun.id}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => setPendingLiveRun(null)}
            >
              View that run →
            </Link>{' '}
            to cancel it instead, if it shouldn&rsquo;t be running.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingLiveRun(null)}
              className="rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPendingLiveRun(null);
                void rerun(true);
              }}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Queue it anyway
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
