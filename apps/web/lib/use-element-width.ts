'use client';

/**
 * An element's live width, for layout decided by the room a component
 * actually has rather than by the window — a chat column beside an app
 * menu and a code pane is narrower than any media query knows. Null
 * until the first measurement lands (SSR has no boxes).
 */

import { useEffect, useState, type RefObject } from 'react';

export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
