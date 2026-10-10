'use client';

import { useState } from 'react';
import { useRefresh } from '@/lib/use-refresh';

/**
 * The administrator's one irreversible act on the Access page: removing a
 * person's encryption key (docs/delegate-key-design.md, "Loss"). Everything
 * of theirs becomes unreadable, to them and to Renkei alike, so it asks
 * twice — once in words, once by typing the person's name.
 */
export default function ShredKeyButton({ subject, displayName }: {
  subject: string;
  displayName: string;
}) {
  const { refresh, pending } = useRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function shred() {
    if (
      !window.confirm(
        `Remove ${displayName}'s encryption key? Their chats, connections and memory become unreadable to everyone, Renkei included, and nothing can bring them back. Chats they shared stay readable to the people they shared them with.`
      )
    ) {
      return;
    }
    const typed = window.prompt(`Type the person's name to confirm: ${displayName}`);
    if (typed === null || typed.trim() !== displayName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/access/${encodeURIComponent(subject)}/keys`,
        { method: 'DELETE' }
      );
      const data: { success?: unknown; error?: unknown } = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) {
        setError(typeof data.error === 'string' ? data.error : 'Could not remove the key');
        return;
      }
      refresh();
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
        onClick={() => void shred()}
        disabled={busy || pending}
        className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
        title="Remove this person's encryption key; nothing of theirs can be read again"
        data-testid={`shred-key-${subject}`}
      >
        {busy ? 'Removing…' : 'Remove key'}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
