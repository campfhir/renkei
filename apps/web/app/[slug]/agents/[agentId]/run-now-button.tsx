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
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { invokeAgentRun } from '@/lib/agents/invoke-client';
import { Icon, ICONS } from '@/components/icons';
import ConfirmRunModal from '../confirm-run-modal';

export default function RunNowButton({
  slug,
  tenantId,
  agentId,
  agentName,
}: {
  slug: string;
  tenantId: string;
  agentId: string;
  agentName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);

  const start = async (confirm = false) => {
    setBusy(true);
    setError(null);
    setStartedRunId(null);
    const result = await invokeAgentRun(tenantId, agentId, confirm);
    setBusy(false);
    switch (result.kind) {
      case 'needs-confirm':
        setConfirmMessage(result.message);
        return;
      case 'error':
        setError(result.message);
        return;
      case 'started':
        setConfirmMessage(null);
        setStartedRunId(result.runId);
        router.refresh();
    }
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
      {confirmMessage ? (
        <ConfirmRunModal
          agentName={agentName}
          message={confirmMessage}
          busy={busy}
          onCancel={() => setConfirmMessage(null)}
          onConfirm={() => void start(true)}
        />
      ) : null}
    </div>
  );
}
