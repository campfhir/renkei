'use client';

/**
 * A single on/off switch backed by a POST endpoint — WebEx's "watch all my
 * spaces" today, and the shape any future per-connector toggle should reuse
 * rather than reinventing the busy/notice/refresh dance.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ToggleControl({
  endpoint,
  checked,
  ariaLabel,
  bodyKey = 'enabled',
}: {
  /** POST endpoint the switch flips against. */
  endpoint: string;
  checked: boolean;
  ariaLabel: string;
  /** JSON body key carrying the new boolean value. */
  bodyKey?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [bodyKey]: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(typeof data.error === 'string' ? data.error : 'Could not update');
        return;
      }
      router.refresh();
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={busy}
        onClick={() => void toggle(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-[1.375rem]' : 'left-0.5'
          }`}
        />
      </button>
      {notice && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{notice}</p>}
    </>
  );
}
