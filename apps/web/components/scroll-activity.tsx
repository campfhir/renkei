'use client';

/**
 * Flags whichever element is mid-scroll, app-wide, with a `data-scrolling`
 * attribute cleared a moment after the wheel or trackpad goes quiet. The
 * CSS this feeds (globals.css: the `[data-scrolling]` rules beside
 * `scrollbar-color`/`::-webkit-scrollbar-thumb`) is what keeps every
 * scroll track in the app invisible at rest and shown only on hover,
 * keyboard focus inside it, or a scroll like this one — never a second
 * border sitting beside a panel's own edge.
 *
 * One listener for the whole app rather than one per scroll container:
 * `scroll` does not bubble, but it does reach a capturing listener on
 * `document` as it fires on each scrolled descendant, so this needs
 * mounting once, here, rather than threaded through every `overflow-auto`
 * div in the tree.
 */

import { useEffect } from 'react';

const CLEAR_AFTER_MS = 800;

export default function ScrollActivity() {
  useEffect(() => {
    const timeouts = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const target = event.target;
      // The page's own scroll fires with `document` as the target; the
      // attribute belongs on the element that actually paints a track.
      const element =
        target instanceof Document ? document.documentElement : target instanceof Element ? target : null;
      if (!element) return;
      element.setAttribute('data-scrolling', '');
      const pending = timeouts.get(element);
      if (pending) clearTimeout(pending);
      timeouts.set(
        element,
        setTimeout(() => element.removeAttribute('data-scrolling'), CLEAR_AFTER_MS)
      );
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);

  return null;
}
