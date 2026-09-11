'use client';

/**
 * Keeps `<html data-theme>` and this browser's cache aligned with the
 * account's saved preference, and — while that preference is 'auto' — with
 * whatever the system answers right now.
 *
 * theme-script.tsx already set the attribute from whatever was cached
 * locally, before this ever runs. This effect only has two jobs beyond
 * that: catch up a browser that has never seen this preference (or saw a
 * stale one from before the last save elsewhere), and keep 'auto' live
 * across a system scheme change without a reload.
 */

import { useEffect } from 'react';
import type { ThemeMode } from '@renkei/user-prefs/prefs';
import { applyThemeMode, getStoredThemeMode, setStoredThemeMode } from '@/lib/theme';

export default function ThemeSync({ tenantId, mode }: { tenantId: string; mode: ThemeMode }) {
  useEffect(() => {
    if (getStoredThemeMode(tenantId) !== mode) {
      setStoredThemeMode(tenantId, mode);
      applyThemeMode(mode);
    }

    if (mode !== 'auto') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeMode('auto');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [tenantId, mode]);

  return null;
}
