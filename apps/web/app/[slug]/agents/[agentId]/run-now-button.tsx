'use client';

/**
 * "Run now" on the overview page, sitting with the schedule it overrides —
 * the agents list has had this button, but the page you land on from a
 * schedule ("does this thing actually work before 8am tomorrow?") had no
 * way to start a run at all.
 *
 * Same endpoint as the list's button (POST .../invoke), so the run is
 * `manual`, executes on the OWNER's grants, and records the presser. On
 * success the new run is linked directly — the reason for pressing it is
 * to watch what happens — and the page refreshes so Recent runs catches
 * up.
 *
 * A second run while one is already `queued`/`running` is safe — the
 * queue's ordering key already runs one agent's jobs strictly serial, so
 * this one just waits its turn — but pressing the button twice by accident
 * is easy to do without meaning it, so the server asks first (409
 * `ALREADY_RUNNING`) rather than silently piling one on. The confirm modal
 * is the one place that ambiguity gets resolved; everywhere else the
 * server is trusted to answer plainly.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';
import Modal from '@/components/modal';

interface InvokeResponse {
  runId?: string;
  code?: string;
  liveRun?: { id: string; status: string };
}

interface LiveRun {
  id: string;
  status: string;
}

export default function RunNowButton({
  slug,
  tenantId,
  agentId,
}: {
  slug: string;
  tenantId: string;
  agentId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingLiveRun, setPendingLiveRun] = useState<LiveRun | null>(null);

  const start = async (confirmQueue = false) => {
    setBusy(true);
    setError(null);
    setStartedRunId(null);
    const result = await sendJsonFull<InvokeResponse>(
      `/api/tenant/${tenantId}/agents/${agentId}/invoke`,
      'POST',
      confirmQueue ? { confirmQueue: true } : undefined
    );
    setBusy(false);
    if (result.error) {
      if (result.data?.code === 'ALREADY_RUNNING' && result.data.liveRun) {
        setPendingLiveRun(result.data.liveRun);
        return;
      }
      setError(result.error);
      return;
    }
    setStartedRunId(result.data?.runId ?? null);
    router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void start()}
        title="Start a run now, without waiting for a trigger."
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        <Icon path={ICONS.play} className="h-3.5 w-3.5" />
        {busy ? 'Starting…' : 'Run now'}
      </button>
      {startedRunId ? (
        <Link
          href={`/${slug}/agents/${agentId}/runs/${startedRunId}`}
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          Run started — open it
        </Link>
      ) : null}
      {error ? (
        <span className="text-right text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : null}

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
                void start(true);
              }}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Queue it anyway
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
