'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJson } from '@/lib/fetch-json';

export function AdminAgentActions({ slug, agentId }: { slug: string; agentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm('Turn this agent off? Its owner can turn it back on.')) return;
          setBusy(true);
          setError(null);
          const failed = await sendJson(`/api/admin/${slug}/agents/${agentId}/disable`, 'POST');
          setBusy(false);
          if (failed) setError(failed);
          else router.refresh();
        }}
        className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
      >
        Turn off
      </button>
    </span>
  );
}
