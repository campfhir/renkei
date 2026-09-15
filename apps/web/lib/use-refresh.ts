'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `router.refresh()` that tells you when it has landed.
 *
 * The common shape in this app is: press a button, `await fetch(...)`, then
 * `router.refresh()` so the server-rendered page shows the new state. The
 * button's own `busy` flag clears the moment the fetch returns — but the
 * refresh re-renders the whole route on the server (the tenant layout's
 * session, prefs and chat list included) and that takes noticeably longer.
 * For that stretch the button is enabled again and the page still shows
 * the old state: it looks as though the press did nothing, and a second
 * press goes through.
 *
 * Wrapping the refresh in a transition gives React's `isPending` for
 * exactly that stretch. Hold the control disabled on `pending` as well as
 * on `busy`, and the gap closes.
 */
export function useRefresh(): { refresh: () => void; pending: boolean } {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = useCallback(() => {
    startTransition(() => {
      router.refresh();
    });
  }, [router]);
  return { refresh, pending };
}
