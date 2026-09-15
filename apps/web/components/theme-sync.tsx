'use client';

/**
 * Keeps `<html data-theme>` and this browser's cache aligned with the
 * account's saved preference, and — while the mode in force is 'auto' —
 * with whatever the system answers right now.
 *
 * theme-script.tsx sets the attribute from the local cache before first
 * paint on a full page load, so there is no flash. This is the component
 * that GUARANTEES it, though, because that script has no other way to run:
 * a `<script>` React inserts on a client-side mount of the tenant layout
 * (arriving from a route outside it, switching tenant) never executes, and
 * neither does one React rebuilt after recovering from a hydration error
 * elsewhere in the tree. So the mode in force is always applied here on
 * mount, unconditionally — an earlier version only applied it when the
 * cache and the server disagreed, and a page whose script never ran was
 * left with no `data-theme` at all: `dark:` utilities off, the `:root`
 * variables following the system, nothing matching until somebody toggled
 * the Appearance setting to make the form apply it by hand.
 *
 * Three things move the mode in force after mount, and every one of them is
 * followed here rather than waiting for a reload:
 *   - the server rendering this shell again with a different saved mode
 *     (a full load, a `router.refresh()`), which also refreshes the cache;
 *   - a pick in the Appearance form, in this tab or another — otherwise the
 *     listener registered for the OLD mode would keep going, and an 'auto'
 *     listener would override a fresh Dark pick the next time the system
 *     scheme changed;
 *   - for 'auto', the system scheme changing. The `matchMedia` change event
 *     is the fast path, but browsers drop it for a tab that is hidden,
 *     suspended, or parked in the back/forward cache (iOS Safari above
 *     all), which is how a phone that went dark overnight opened Renkei
 *     still light in the morning. So 'auto' re-resolves whenever the tab
 *     becomes visible, is restored, or gets focus.
 *
 * `mode` is null for a visitor with no session: their only preference is
 * whatever this browser cached, which is then followed the same way but
 * never overwritten.
 */

import { useEffect, useState } from 'react';
import type { ThemeMode } from '@renkei/user-prefs/prefs';
import {
  applyThemeMode,
  getStoredThemeMode,
  setStoredThemeMode,
  subscribeStoredThemeMode,
} from '@/lib/theme';

export default function ThemeSync({
  tenantId,
  mode,
}: {
  tenantId: string;
  mode: ThemeMode | null;
}) {
  // The mode this tab is rendering right now: the saved preference until a
  // pick in the Appearance form moves it.
  const [current, setCurrent] = useState<ThemeMode>(mode ?? 'auto');

  useEffect(() => {
    if (mode === null) {
      setCurrent(getStoredThemeMode(tenantId) ?? 'auto');
      return;
    }
    // The saved preference wins, and the cache follows it so the inline
    // script agrees on the next full load. Only written when it differs:
    // the write also tells the other tabs, and there is nothing to tell.
    if (getStoredThemeMode(tenantId) !== mode) setStoredThemeMode(tenantId, mode);
    setCurrent(mode);
  }, [tenantId, mode]);

  useEffect(() => subscribeStoredThemeMode(tenantId, setCurrent), [tenantId]);

  useEffect(() => {
    applyThemeMode(current);
    if (current !== 'auto') return;

    const reapply = () => applyThemeMode('auto');
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reapply();
    };
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', reapply);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', reapply);
    window.addEventListener('focus', reapply);
    return () => {
      query.removeEventListener('change', reapply);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', reapply);
      window.removeEventListener('focus', reapply);
    };
  }, [current]);

  return null;
}
