'use client';

/**
 * Says, in the DOM, when React has taken over a piece of the page.
 *
 * A server-rendered page is drawn before its handlers exist: a press on a
 * button, a tap on a `<details>` or text typed into a box in that window
 * reaches the bare HTML and is lost, or undone when React hydrates. People
 * rarely notice; a test driving the page at machine speed hits it often.
 * So the page marks itself instead of being guessed at:
 *
 *   - `HydrationMark`, once in the root layout, sets `data-hydrated="app"`
 *     on `<html>` when the page's shell has hydrated;
 *   - a surface that streams in later, inside a Suspense boundary (a chat
 *     thread, the notifications list, a folding section), hydrates on its
 *     own, so it carries its own mark: `data-hydrated={useHydrated() ?
 *     'chat-thread' : undefined}` on its root element.
 *
 * The browser suite waits on these (`hydrated` in e2e/support/settle.ts)
 * before its first press, rather than pressing until something takes.
 */

import { useEffect, useState } from 'react';

/** True from the first effect on: this component's tree has hydrated. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/** Marks `<html data-hydrated="app">` once the page's shell has hydrated. */
export default function HydrationMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'app';
  }, []);
  return null;
}
