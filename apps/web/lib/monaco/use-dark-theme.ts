'use client';

/**
 * Whether Monaco should be dark right now. Driven as a PROP, not by
 * monaco.editor.setTheme: the Editor component applies its own `theme` at
 * mount (defaulting to light), so an imperative call made beforehand is
 * overwritten and the editor comes up white inside a dark page. The page
 * has three theme states — explicit dark, explicit light, and system —
 * so both the data-theme attribute and the media query matter, and
 * either can change while an editor is open.
 */

import { useEffect, useState } from 'react';

export function useMonacoDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      setDark(
        document.documentElement.dataset.theme === 'dark' ||
          (document.documentElement.dataset.theme !== 'light' && media.matches)
      );
    };
    apply();
    media.addEventListener('change', apply);
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      media.removeEventListener('change', apply);
      observer.disconnect();
    };
  }, []);
  return dark;
}
