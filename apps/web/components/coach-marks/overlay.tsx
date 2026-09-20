'use client';

/**
 * One step of a tour, drawn over the page: the spotlight around the
 * step's target, the dimmed rest, and the card that says what the target
 * is for. Portalled to <body> for the reason modal.tsx gives — the sticky
 * nav column and the phone drawer each break a `position: fixed` child —
 * and at z-[60], one notch above the z-50 that toasts, the drawer and
 * every dialog share (toast-stack.tsx's budget): a tour is the thing in
 * front by definition, and nothing it explains should paint over it.
 *
 * The spotlight is a box-shadow. A box the size of the target with a
 * shadow wider than any screen dims everything but the target, without an
 * SVG mask or four rectangles to keep in agreement; a transition on its
 * geometry is what makes the light slide from one step to the next.
 *
 * A target is looked for rather than assumed: pages hydrate, the chat's
 * composer mounts after its thread, and a step may have just navigated.
 * When nothing visible answers within a moment — the menu column is a
 * drawer on a phone, and an anchor a page never rendered is still a valid
 * tour — the card sits centred with no spotlight, and the looking goes on
 * more slowly in case the page is merely late. Every step's copy is
 * written to survive the centred case.
 *
 * The page underneath does not take clicks while a step is up. A tour is
 * a caption for a workflow, not a mode in which to perform it; letting a
 * spotlighted button through would let a click navigate away from a step
 * that still expects its target.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import { useMediaQuery } from '@/lib/use-media-query';
import { coachSelector } from '@/lib/coach-marks/anchors';
import type { CoachMarkPlacement, CoachMarkTour } from '@/lib/coach-marks/types';

/** Whether an element takes up space somewhere a person could see it. */
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  // The phone drawer parks itself at left: -100%: on the page, off the screen.
  if (rect.right <= 0 || rect.bottom <= 0) return false;
  if (rect.left >= window.innerWidth) return false;
  return true;
}

/** The first visible element carrying the anchor; the menu renders twice, drawer and column. */
function findTarget(selector: string): Element | null {
  for (const element of document.querySelectorAll(selector)) {
    if (isVisible(element)) return element;
  }
  return null;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOT_PAD = 6;
const GAP = 12;
const MARGIN = 16;
/** How long a step waits for its target before showing the card centred. */
const LOOK_FOR_MS = 2000;
const LOOK_EVERY_MS = 100;
/** After that, the target is still looked for — a page may finish loading late — but at a stroll. */
const LOOK_LATE_EVERY_MS = 500;

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - SPOT_PAD,
    left: rect.left - SPOT_PAD,
    width: rect.width + SPOT_PAD * 2,
    height: rect.height + SPOT_PAD * 2,
  };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * Where the card goes beside its spotlight: the preferred side when it
 * fits, otherwise the first of the others that does, otherwise below,
 * clamped into the viewport either way.
 */
function placeCard(
  spot: Box,
  card: { width: number; height: number },
  preferred: CoachMarkPlacement
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
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

export default function CoachMarkOverlay({
  tour,
  index,
  onNext,
  onBack,
  onSkip,
  onMute,
}: {
  tour: CoachMarkTour;
  index: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** "Don't show tutorials" — offered only on a tour that started unasked. */
  onMute: (() => void) | null;
}) {
  const step = tour.steps[index];
  const isLast = index === tour.steps.length - 1;
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<Element | null>(null);
  const narrow = useMediaQuery('(max-width: 639.98px)');

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // null while looking, or when nothing was found; a Box once found.
  const [spot, setSpot] = useState<Box | null>(null);
  const [looked, setLooked] = useState(false);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  // Find the step's target, waiting briefly for it to appear.
  useEffect(() => {
    targetRef.current = null;
    setSpot(null);
    setLooked(false);
    setCardPos(null);
    if (!step.target) {
      setLooked(true);
      return;
    }
    const selector = coachSelector(step.target);
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const look = () => {
      const found = findTarget(selector);
      if (found) {
        targetRef.current = found;
        found.scrollIntoView({ block: 'center', inline: 'nearest' });
        setSpot(boxOf(found));
        setLooked(true);
        return;
      }
      const late = Date.now() - startedAt >= LOOK_FOR_MS;
      if (late) setLooked(true);
      timer = setTimeout(look, late ? LOOK_LATE_EVERY_MS : LOOK_EVERY_MS);
    };
    look();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [step.target, index, tour.id]);

  // Keep the spotlight on the target as the page moves under it.
  const refresh = useCallback(() => {
    const element = targetRef.current;
    if (!element) return;
    if (!element.isConnected || !isVisible(element)) {
      targetRef.current = null;
      setSpot(null);
      return;
    }
    setSpot((current) => {
      const next = boxOf(element);
      return current &&
        current.top === next.top &&
        current.left === next.left &&
        current.width === next.width &&
        current.height === next.height
        ? current
        : next;
    });
  }, []);
  useEffect(() => {
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    const interval = setInterval(refresh, 250);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
      clearInterval(interval);
    };
  }, [refresh]);

  // Place the card once it has a size and the spotlight has a place.
  useLayoutEffect(() => {
    if (!spot || narrow || !cardRef.current) {
      setCardPos(null);
      return;
    }
    const rect = cardRef.current.getBoundingClientRect();
    setCardPos(
      placeCard(spot, { width: rect.width, height: rect.height }, step.placement ?? 'auto')
    );
  }, [spot, narrow, step.placement, index]);

  // Focus follows the step, so a screen reader announces each card and
  // the arrow keys work without a click.
  useEffect(() => {
    if (!looked) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [looked, index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        onNext();
      } else if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip, onNext, onBack, index]);

  if (!mounted || !looked) return null;

  const centred = spot === null;
  const cardStyle = centred
    ? undefined
    : narrow
      ? { left: MARGIN, right: MARGIN, bottom: MARGIN }
      : cardPos
        ? { top: cardPos.top, left: cardPos.left }
        : { top: MARGIN, left: MARGIN, visibility: 'hidden' as const };

  const card = (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="coach-mark"
      data-coach-tour={tour.id}
      data-coach-step={step.id}
      style={cardStyle}
      className={`${centred ? 'relative' : 'fixed'} w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-4 text-gray-900 shadow-2xl outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="truncate">{tour.title}</span>
        <span className="shrink-0" aria-label={`Step ${index + 1} of ${tour.steps.length}`}>
          {index + 1} of {tour.steps.length}
        </span>
      </div>
      <h2 id={titleId} className="text-base font-semibold">
        {step.title}
      </h2>
      <p id={bodyId} className="mt-1.5 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
        {step.body}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onSkip}
          className="rounded-md px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900"
        >
          Skip tour
        </button>
        <div className="ml-auto flex items-center gap-2">
          {index > 0 ? (
            <button
              type="button"
              onClick={onBack}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              Back
            </button>
          ) : null}
          <button
            type="button"
            onClick={onNext}
            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            {isLast ? 'Finish' : 'Next'}
            {isLast ? null : <Icon path={ICONS.arrowRight} className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex gap-1" aria-hidden="true">
          {tour.steps.map((entry, position) => (
            <span
              key={entry.id}
              className={`h-1.5 w-1.5 rounded-full ${
                position === index ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'
              }`}
            />
          ))}
        </div>
        {onMute ? (
          <button
            type="button"
            onClick={onMute}
            className="text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
          >
            Don&apos;t show tutorials
          </button>
        ) : null}
      </div>
    </div>
  );

  return createPortal(
    <div data-testid="coach-mark-layer" className="fixed inset-0 z-[60]">
      {centred ? (
        <div className="flex h-full w-full items-center justify-center bg-black/55 p-4">{card}</div>
      ) : (
        <>
          {/* Takes every click the page would otherwise get. */}
          <div className="absolute inset-0" aria-hidden="true" />
          <div
            data-testid="coach-mark-spotlight"
            aria-hidden="true"
            style={{
              top: spot.top,
              left: spot.left,
              width: spot.width,
              height: spot.height,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
            }}
            className="pointer-events-none absolute rounded-lg ring-2 ring-blue-500 transition-[top,left,width,height] duration-200 ease-out"
          />
          {card}
        </>
      )}
    </div>,
    document.body
  );
}
