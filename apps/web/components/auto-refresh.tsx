'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keep a server-rendered page current without a reload.
 *
 * `router.refresh()` re-runs the server component and swaps in the new
 * payload, so the feed below stays a plain server component reading the
 * database directly — no duplicate query in an API route, no client-side
 * copy of the rendering, and no loading flash. Scroll position, open
 * `<details>` and in-flight form state all survive.
 *
 * Two things it deliberately does NOT do:
 *
 *   - Poll a hidden tab. A window left open on this page for a weekend
 *     would otherwise run a database query every interval for days with
 *     nobody looking. It refreshes once when the tab becomes visible again,
 *     which is the moment the staleness actually matters.
 *   - Refresh while the browser is offline. The call would fail and the
 *     next one is a whole interval away.
 */
export default function AutoRefresh({
  /** How often to refresh while the tab is visible. */
  intervalMs = 30_000,
}: {
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      router.refresh();
    };

    const timer = setInterval(refresh, intervalMs);
    // Coming back to the tab is when a stale view is most obvious, and the
    // interval that fired while it was hidden did nothing.
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [router, intervalMs]);

  return null;
}
