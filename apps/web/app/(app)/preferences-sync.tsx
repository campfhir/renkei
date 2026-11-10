'use client';

/**
 * Re-renders the shell when the person's preferences change somewhere
 * other than the form that shows them (lib/preferences-events.ts): the
 * chat's model switching to dark mode on their word, or a save in another
 * tab.
 *
 * The layout reads the theme (its mode and the line-number gutter) on the
 * server, so asking the server for the page again is what carries a change
 * into ThemeSync and the code blocks; nothing here duplicates what they do
 * with it. The mode is also put in this browser's cache at once
 * (lib/theme.ts), so the switch does not wait on that round trip and the
 * next full load paints it before first paint. Which changes are worth a
 * refresh is preferences-sync.model.ts's.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ThemeMode } from '@renkei/user-prefs/prefs';
import { subscribePreferencesChanged } from '@/lib/preferences-events';
import { setStoredThemeMode } from '@/lib/theme';
import { clientLogger } from '@/lib/client-logger';
import { shellRefreshes, themeChanged } from './preferences-sync.model';

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** The saved theme mode, read fresh; null when it could not be read. */
async function savedThemeMode(): Promise<ThemeMode | null> {
  try {
    const response = await fetch('/api/preferences');
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('theme' in body)) return null;
    const theme: unknown = body.theme;
    if (typeof theme !== 'object' || theme === null || !('mode' in theme)) return null;
    return isThemeMode(theme.mode) ? theme.mode : null;
  } catch (error) {
    clientLogger.warn('preferences', 'could not re-read the theme after a change', error);
    return null;
  }
}

export default function PreferencesSync() {
  const router = useRouter();
  useEffect(
    () =>
      subscribePreferencesChanged(({ documents }) => {
        if (themeChanged(documents)) {
          void savedThemeMode().then((mode) => {
            if (mode) setStoredThemeMode(mode);
          });
        }
        if (shellRefreshes(documents)) router.refresh();
      }),
    [router]
  );
  return null;
}
