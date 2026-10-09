'use client';

/**
 * The chat's box: the height under the top bar, and — on a phone — the
 * height under the top bar AND above the keyboard. Chrome on Android
 * shrinks the layout viewport for a keyboard when the viewport meta asks
 * (app/layout.tsx), so `100dvh` already tracks it there. iOS Safari never
 * does: the page keeps its height and the keyboard simply covers the
 * bottom of it. The visual viewport is the one thing that does shrink, so
 * while it is markedly shorter than the window the box is sized to it and
 * the window is held at the top, which puts the composer right above the
 * keys.
 */

import { useEffect, useState, type ReactNode } from 'react';

/** The top bar's height (h-14). */
const TOP_BAR_PX = 56;
/** Smaller gaps are browser chrome coming and going, not a keyboard. */
const KEYBOARD_MIN_PX = 120;

export default function ChatFrame({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = window.innerHeight - viewport.height;
      if (covered > KEYBOARD_MIN_PX) {
        setHeight(Math.max(0, Math.round(viewport.height) - TOP_BAR_PX));
        // Safari scrolls the page to show the focused field; with the box
        // now sized to the visible area that scroll only hides the title.
        if (window.scrollY > 0 || viewport.offsetTop > 0) window.scrollTo(0, 0);
      } else {
        setHeight(null);
      }
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div
      data-wide-page
      data-flush-page
      className="h-[calc(100dvh-3.5rem)] min-h-[24rem]"
      style={height !== null ? { height, minHeight: 0 } : undefined}
    >
      {children}
    </div>
  );
}
