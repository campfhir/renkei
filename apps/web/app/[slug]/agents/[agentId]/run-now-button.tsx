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
import { sendJsonFull } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';

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

  const start = async () => {
    setBusy(true);
    setError(null);
    setStartedRunId(null);
    const result = await sendJsonFull<{ runId?: string }>(
      `/api/tenant/${tenantId}/agents/${agentId}/invoke`,
      'POST'
    );
    setBusy(false);
    if (result.error) {
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
    </div>
  );
}
