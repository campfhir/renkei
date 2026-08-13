'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Archive/unarchive control for one decided card. Archiving only changes
 * whether the card occupies the feed — the decision and its audit trail are
 * untouched, and the history view still shows everything.
 */
export default function ArchiveAction({
  tenantId,
  itemId,
  archived,
}: {
  tenantId: string;
  itemId: string;
  archived: boolean;
}): React.ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/actionable-items/${itemId}/archive`, {
        method: archived ? 'DELETE' : 'POST',
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        let message = `Request failed (${response.status})`;
        if (typeof body === 'object' && body !== null) {
          const record: Record<string, unknown> = { ...body };
          if (typeof record.error === 'string') message = record.error;
        }
        setError(message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        onClick={() => void toggle()}
        disabled={busy}
        className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900"
      >
        {archived ? 'Unarchive' : 'Archive'}
      </button>
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
