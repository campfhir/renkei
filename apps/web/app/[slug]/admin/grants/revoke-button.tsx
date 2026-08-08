'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The one interactive element on the grants page, split out because the page
 * is a server component and event handlers cannot cross that boundary.
 * Revoking is destructive (the user must re-authorize Jira), so it confirms
 * first.
 */
export default function RevokeButton({
  slug,
  accountId,
  displayName,
}: {
  slug: string;
  accountId: string;
  displayName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!window.confirm(`Revoke access for ${displayName}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/${slug}/grants/${accountId}/revoke`, {
        method: 'POST',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
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
    <>
      <button
        onClick={() => void revoke()}
        disabled={busy}
        className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {busy ? 'Revoking…' : 'Revoke'}
      </button>
      {error && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</p>}
    </>
  );
}
