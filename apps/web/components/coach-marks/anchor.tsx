'use client';

/**
 * How a component becomes a step's target.
 *
 *   const anchor = useCoachAnchor('agents-new');
 *   <Link href=… {...anchor}>New agent</Link>
 *
 * The spread carries a ref that registers the element with the engine
 * while it is mounted, and a `data-coach` attribute so a test can find it
 * by the same name. Nothing is looked up in the DOM: the engine knows the
 * anchor is on screen because this ran, and forgets it when the cleanup
 * runs. Outside a provider (a unit test rendering one component) the
 * hook is inert.
 *
 * A server component cannot call a hook; it wraps the element in
 * `<CoachTarget name=…>` instead, which is this hook on a plain box.
 */

import { createElement, useCallback, useContext, type ReactNode } from 'react';
import { CoachAnchorContext } from './context';
import type { CoachAnchor } from '@/lib/coach-marks/anchors';

export interface CoachAnchorProps {
  ref: (element: Element | null) => void | (() => void);
  'data-coach': CoachAnchor;
}

export function useCoachAnchor(name: CoachAnchor): CoachAnchorProps {
  const register = useContext(CoachAnchorContext);
  const ref = useCallback(
    (element: Element | null) => {
      if (!element || !register) return undefined;
      return register(name, element);
    },
    [name, register]
  );
  return { ref, 'data-coach': name };
}

/** An anchor as a box of its own, for the places a hook cannot go. */
export default function CoachTarget({
  name,
  as = 'div',
  className,
  children,
}: {
  name: CoachAnchor;
  as?: 'div' | 'span' | 'section';
  className?: string;
  children?: ReactNode;
}) {
  const anchor = useCoachAnchor(name);
  return createElement(as, { ...anchor, className }, children);
}
