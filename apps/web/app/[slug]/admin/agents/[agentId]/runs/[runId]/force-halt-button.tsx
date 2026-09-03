'use client';

/**
 * The one non-read-only control on the admin run page — see
 * lib/agents/force-halt.ts for why it exists and what it bypasses. Confirms
 * first: unlike the owner's Cancel button, this can end a run whose queue
 * job still looks live, so a stray click is worth one extra step to catch.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJsonFull } from '@/lib/fetch-json';

export default function ForceHaltButton({
  slug,
  agentId,
  runId,
}: {
  slug: string;
  agentId: string;
  runId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forceHalt = async () => {
    if (busy) return;
    if (
      !window.confirm(
        'Force halt this run? Only use this when it is genuinely stuck — it stops the run immediately, even if a worker still appears to be processing it.'
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendJsonFull<{ ok: true }>(
      `/api/admin/${slug}/agents/${agentId}/runs/${runId}/force-halt`,
      'POST'
    );
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void forceHalt()}
        disabled={busy}
        title="Force this run to a stop — for a run that is genuinely stuck and won't cancel on its own"
        className="rounded-md border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:border-red-500 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        {busy ? 'Halting…' : 'Force halt'}
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
