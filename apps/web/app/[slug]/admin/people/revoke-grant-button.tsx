'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The one interactive element on the people page, split out because the
 * page is a server component. Revoking cuts the person's connector off
 * immediately (they reconnect any time), so it confirms first.
 */
export default function RevokeGrantButton({
  slug,
  provider,
  providerLabel,
  accountId,
  displayName,
}: {
  slug: string;
  provider: string;
  providerLabel: string;
  accountId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!window.confirm(`Disconnect ${providerLabel} for ${displayName}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/${slug}/grants/${encodeURIComponent(accountId)}/revoke`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        }
      );
      const data: { success?: unknown; error?: unknown } = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) {
        setError(typeof data.error === 'string' ? data.error : 'Revoke failed');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void revoke()}
        disabled={busy}
        aria-label={`Disconnect ${providerLabel}`}
        title={`Disconnect ${providerLabel}`}
        className="rounded p-0.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/30 dark:hover:text-red-400"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
