'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useNotifications } from '@/components/notification-center';

/**
 * "Mark all read", which has two jobs: the rows, and the badge.
 *
 * `router.refresh()` re-runs the server component so the list restyles, and
 * `refresh()` re-polls so the nav badge drops in the same beat. Without the
 * second one the count sits there stale for up to twenty seconds, which
 * reads as the button not having worked.
 */
export default function MarkAllRead({ tenantId }: { tenantId: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { refresh } = useNotifications();

  async function markAll() {
    setBusy(true);
    try {
      await fetch(`/api/tenant/${tenantId}/notifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      refresh();
      router.refresh();
    } catch {
      // Nothing was marked; the rows stay unread and the button stays there.
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void markAll()}
      disabled={busy}
      className="shrink-0 rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
    >
      {busy ? 'Marking…' : 'Mark all read'}
    </button>
  );
}
