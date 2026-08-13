'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Approve/dismiss controls for one suggested card. Approval needs a Jira
 * project key — the classifier cannot know which project an issue belongs
 * in, so that choice stays with the human.
 */
export default function CardActions({
  tenantId,
  itemId,
}: {
  tenantId: string;
  itemId: string;
}): React.ReactNode {
  const router = useRouter();
  const [projectKey, setProjectKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'dismiss'): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/actionable-items/${itemId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          decision === 'approve'
            ? { decision, projectKey: projectKey.trim().toUpperCase() }
            : { decision }
        ),
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
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={projectKey}
        onChange={(e) => setProjectKey(e.target.value)}
        placeholder="Project key (e.g. SCRUM)"
        className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
      />
      <button
        onClick={() => void decide('approve')}
        disabled={busy || projectKey.trim().length === 0}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Approve → create issue
      </button>
      <button
        onClick={() => void decide('dismiss')}
        disabled={busy}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
      >
        Dismiss
      </button>
      {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
