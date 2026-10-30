/**
 * Where a small floating box — a per-row menu, the composer's path
 * completions — goes relative to what opened it, without leaving the
 * viewport: below the anchor when there is room, above it when there is
 * not, and pulled back inside the viewport's edges either way. A pure
 * function over rectangles so the choice is testable without a DOM; the
 * hook beside it measures and re-measures as the page scrolls or resizes.
 */

import { useLayoutEffect, useState, type RefObject } from 'react';

export interface FloatingBox {
  /** Viewport coordinates, for `position: fixed`. */
  top: number;
  left: number;
  /** Which side of the anchor the box ended up on. */
  placement: 'below' | 'above';
}

export interface FloatingOptions {
  /** Which edge of the box lines up with the anchor's: its left or its right. */
  align: 'start' | 'end';
  /** Space between the anchor and the box. */
  gap?: number;
  /** Space kept from the viewport's edges. */
  margin?: number;
  /** Below when it fits (a menu), or above when it fits (a composer's completions). */
  prefer?: 'below' | 'above';
}

export function placeFloating(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: FloatingOptions
): FloatingBox {
  const gap = options.gap ?? 4;
  const margin = options.margin ?? 8;
  const prefer = options.prefer ?? 'below';
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const fitsBelow = size.height <= roomBelow;
  const fitsAbove = size.height <= roomAbove;
  let placement: 'below' | 'above';
  if (prefer === 'below') placement = fitsBelow || !fitsAbove ? 'below' : 'above';
  else placement = fitsAbove || !fitsBelow ? 'above' : 'below';
  // Neither side fits whole: take the roomier one.
  if (!fitsBelow && !fitsAbove) placement = roomBelow >= roomAbove ? 'below' : 'above';
  const top =
    placement === 'below'
      ? Math.min(anchor.bottom + gap, viewport.height - margin - size.height)
      : Math.max(margin, anchor.top - gap - size.height);
  const rawLeft = options.align === 'end' ? anchor.right - size.width : anchor.left;
  const left = Math.max(margin, Math.min(rawLeft, viewport.width - margin - size.width));
  return { top: Math.max(margin, top), left, placement };
}

/**
 * The box's fixed position while it is open: measured once it has
 * rendered (so its own size is known), again whenever anything scrolls
 * or the window resizes. Null before the first measure — a caller
 * renders the box invisibly (`visibility: hidden`) until then so there
 * is no flash at the wrong place.
 */
export function useFloating(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  boxRef: RefObject<HTMLElement | null>,
  options: FloatingOptions
): FloatingBox | null {
  const [box, setBox] = useState<FloatingBox | null>(null);
  const { align, gap, margin, prefer } = options;
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const floating = boxRef.current;
      if (!anchor || !floating) return;
      setBox(
        placeFloating(
          anchor,
          { width: floating.offsetWidth, height: floating.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          { align, gap, margin, prefer }
        )
      );
    };
    measure();
    window.addEventListener('resize', measure);
    // Capture: a scroll anywhere up the tree moves the anchor.
    document.addEventListener('scroll', measure, true);
    const observer =
      typeof ResizeObserver === 'undefined' || !boxRef.current
        ? null
        : new ResizeObserver(measure);
    if (boxRef.current) observer?.observe(boxRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
      observer?.disconnect();
    };
  }, [open, anchorRef, boxRef, align, gap, margin, prefer]);
  return box;
}
