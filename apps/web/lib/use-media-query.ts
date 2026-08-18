'use client';

/**
 * Live media-query state. Returns `defaultValue` until the first client
 * render commits (SSR has no viewport), then tracks the query. Callers that
 * only branch on user interaction — opening a panel, choosing modal vs
 * sidebar — never hit a hydration mismatch, because nothing query-dependent
 * is in the server HTML.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = useState(defaultValue);

  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
