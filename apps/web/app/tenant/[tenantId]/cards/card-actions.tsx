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
      const response = await fetch(
        `/api/tenant/${tenantId}/actionable-items/${itemId}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            decision === 'approve'
              ? { decision, projectKey: projectKey.trim().toUpperCase() }
              : { decision }
          ),
        }
      );
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
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <input
        value={projectKey}
        onChange={(e) => setProjectKey(e.target.value)}
        placeholder="Project key (e.g. SCRUM)"
        style={{ padding: '0.4rem', border: '1px solid #ccc', borderRadius: '4px' }}
      />
      <button
        onClick={() => void decide('approve')}
        disabled={busy || projectKey.trim().length === 0}
        style={{ padding: '0.4rem 0.8rem' }}
      >
        Approve → create issue
      </button>
      <button onClick={() => void decide('dismiss')} disabled={busy} style={{ padding: '0.4rem 0.8rem' }}>
        Dismiss
      </button>
      {error && <span style={{ color: '#b00' }}>{error}</span>}
    </div>
  );
}
