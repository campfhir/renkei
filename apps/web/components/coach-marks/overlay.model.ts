/**
 * What one coach-mark step decides (overlay.tsx), with no React or DOM:
 * where the spotlight and the card go for a given viewport, which key
 * does what, and what the card's counter and buttons say. The overlay
 * measures (getBoundingClientRect, innerWidth/innerHeight) and hands the
 * numbers in. Tested in overlay.model.test.ts.
 */

import type { CoachMarkPlacement } from '@/lib/coach-marks/types';

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface CardPosition {
  top: number;
  left: number;
}

export const SPOT_PAD = 6;
export const GAP = 12;
export const MARGIN = 16;
/** The sticky top bar (nav.tsx's h-14) that a target scrolled to the top must clear. */
export const TOP_BAR = 56;

/** The spotlight around a target's rectangle: a little room on every side. */
export function spotlightFor(rect: Box): Box {
  return {
    top: rect.top - SPOT_PAD,
    left: rect.left - SPOT_PAD,
    width: rect.width + SPOT_PAD * 2,
    height: rect.height + SPOT_PAD * 2,
  };
}

export function sameBox(a: Box | null, b: Box): boolean {
  return (
    a !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * A target taller than the screen under the top bar (a settings grid, the
 * console's areas) is brought to the top rather than centred, so its
 * heading is what is read.
 */
export function isTall(targetHeight: number, viewportHeight: number): boolean {
  return targetHeight > viewportHeight - TOP_BAR - MARGIN;
}

/** How far to scroll a tall target, once at the top, so it clears the top bar; 0 when it does. */
export function topBarCorrection(targetTop: number): number {
  return targetTop < TOP_BAR + MARGIN ? targetTop - TOP_BAR - MARGIN : 0;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * On a narrow screen the card spans the width at the top or the bottom
 * edge. The bottom, as a rule — the top of a target is its heading, and
 * a card there hides what the target is — unless the bottom would cover
 * more than twice as much of the spotlight (the Chat group in the
 * drawer, which runs on down the screen).
 */
export function narrowEdgeFor(
  spot: Box,
  cardHeight: number,
  viewportHeight: number
): 'top' | 'bottom' {
  const vh = viewportHeight;
  const bottom = spot.top + spot.height;
  const atTop = Math.max(0, Math.min(bottom, MARGIN + cardHeight) - Math.max(spot.top, MARGIN));
  const atBottom = Math.max(
    0,
    Math.min(bottom, vh - MARGIN) - Math.max(spot.top, vh - MARGIN - cardHeight)
  );
  return atTop * 2 < atBottom ? 'top' : 'bottom';
}

/**
 * Where the card goes beside its spotlight: the preferred side when it
 * fits, otherwise the first of the others that does (bottom, top, right,
 * left), otherwise below, clamped into the viewport either way.
 */
export function placeCard(
  spot: Box,
  card: { width: number; height: number },
  preferred: CoachMarkPlacement,
  viewport: Viewport
): CardPosition {
  const vw = viewport.width;
  const vh = viewport.height;
  const order: CoachMarkPlacement[] = ['bottom', 'top', 'right', 'left'];
  const sides =
    preferred === 'auto' ? order : [preferred, ...order.filter((side) => side !== preferred)];
  const centreX = spot.left + spot.width / 2;
  const centreY = spot.top + spot.height / 2;
  const maxLeft = Math.max(MARGIN, vw - MARGIN - card.width);
  const maxTop = Math.max(MARGIN, vh - MARGIN - card.height);

  for (const side of sides) {
    switch (side) {
      case 'bottom': {
        const top = spot.top + spot.height + GAP;
        if (top + card.height <= vh - MARGIN) {
          return { top, left: clamp(centreX - card.width / 2, MARGIN, maxLeft) };
        }
        break;
      }
      case 'top': {
        const top = spot.top - GAP - card.height;
        if (top >= MARGIN) return { top, left: clamp(centreX - card.width / 2, MARGIN, maxLeft) };
        break;
      }
      case 'right': {
        const left = spot.left + spot.width + GAP;
        if (left + card.width <= vw - MARGIN) {
          return { top: clamp(centreY - card.height / 2, MARGIN, maxTop), left };
        }
        break;
      }
      case 'left': {
        const left = spot.left - GAP - card.width;
        if (left >= MARGIN) return { top: clamp(centreY - card.height / 2, MARGIN, maxTop), left };
        break;
      }
      default:
        break;
    }
  }
  return {
    top: clamp(spot.top + spot.height + GAP, MARGIN, maxTop),
    left: clamp(centreX - card.width / 2, MARGIN, maxLeft),
  };
}

export type CardStyle =
  | undefined
  | { left: number; right: number; top: number }
  | { left: number; right: number; bottom: number }
  | { top: number; left: number }
  | { top: number; left: number; visibility: 'hidden' };

/**
 * The card's own position: none when it sits centred (no spotlight); on a
 * narrow screen, full width at the chosen edge; otherwise where
 * `placeCard` put it — hidden for the one frame before it has been
 * measured, so it never flashes in the corner.
 */
export function cardStyleFor(input: {
  spot: Box | null;
  narrow: boolean;
  narrowEdge: 'top' | 'bottom';
  cardPos: CardPosition | null;
}): CardStyle {
  if (input.spot === null) return undefined;
  if (input.narrow) {
    return input.narrowEdge === 'top'
      ? { left: MARGIN, right: MARGIN, top: MARGIN }
      : { left: MARGIN, right: MARGIN, bottom: MARGIN };
  }
  return input.cardPos
    ? { top: input.cardPos.top, left: input.cardPos.left }
    : { top: MARGIN, left: MARGIN, visibility: 'hidden' };
}

/** Escape skips, → is Next (Finish on the last), ← is Back — except on the first step. */
export function keyAction(key: string, index: number): 'skip' | 'next' | 'back' | null {
  if (key === 'Escape') return 'skip';
  if (key === 'ArrowRight') return 'next';
  if (key === 'ArrowLeft' && index > 0) return 'back';
  return null;
}

/** What the card's controls say on step `index` (0-based) of `total`. */
export function stepControls(index: number, total: number) {
  const isLast = index === total - 1;
  return {
    counter: `${index + 1} of ${total}`,
    counterLabel: `Step ${index + 1} of ${total}`,
    primary: isLast ? ('Finish' as const) : ('Next' as const),
    showBack: index > 0,
    isLast,
  };
}
