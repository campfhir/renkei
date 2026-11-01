/**
 * The coach-mark engine's step machine (provider.tsx), with no React,
 * storage, timer or network: when a tour starts — asked for, or unasked —
 * how Next, Back, Skip and Finish move it, which turn is reported to the
 * server at which step, and how the local copy of the person's rows moves
 * as it does. Which tour belongs where is `lib/coach-marks/select.ts`'s;
 * how one report moves a row is `lib/coach-marks/progress.ts`'s. Both are
 * used here, not repeated.
 *
 * The provider keeps a `CoachMarksState`, hands each thing the person did
 * to `transition` with the moment it happened, and carries out the
 * effects that come back: post a report, navigate, save the preference.
 * Tested in provider.model.test.ts.
 */

import type { CoachAnchor } from '@/lib/coach-marks/anchors';
import { applyCoachMarkEvent, type CoachMarkRecord } from '@/lib/coach-marks/progress';
import { isEligible, pickAutoStartTour, toursFor } from '@/lib/coach-marks/select';
import type { CoachMarkEvent, CoachMarkProgressView, CoachMarkTour } from '@/lib/coach-marks/types';

/** A request older than this is stale — the person went elsewhere — and is dropped. */
export const PENDING_TTL_MS = 60_000;

export interface ActiveTour {
  tour: CoachMarkTour;
  index: number;
  /** Started from the Tutorials page or a link, not unasked. */
  manual: boolean;
}

export interface CoachMarksState {
  active: ActiveTour | null;
  /** The person's own switch for tours that start unasked. */
  autoStart: boolean;
  progress: ReadonlyMap<string, CoachMarkProgressView>;
  /** Where the last tour ended: nothing starts unasked there again until the person moves on. */
  endedOn: string | null;
  /**
   * The moment of the last report, ms. Each report carries one strictly
   * later than the last within this tab, so reports may leave at once and
   * land in any order: the server ignores one older than the last applied.
   */
  lastReportAt: number;
}

export function initCoachMarks(input: {
  autoStart: boolean;
  progress: readonly CoachMarkProgressView[];
}): CoachMarksState {
  return {
    active: null,
    autoStart: input.autoStart,
    progress: new Map(input.progress.map((row) => [row.tourId, row])),
    endedOn: null,
    lastReportAt: 0,
  };
}

export type CoachMarksAction =
  /** A tour begins at its first step: asked for (`manual`) or unasked. */
  | { type: 'begin'; tour: CoachMarkTour; manual: boolean; now: number }
  /** Next (or the right arrow); on the last step it is Finish. `path` is the page in front. */
  | { type: 'next'; path: string; now: number }
  /** Back (or the left arrow). */
  | { type: 'back' }
  /** Skip tour (or Escape). */
  | { type: 'skip'; path: string; now: number }
  /** "Don't show tutorials": auto-start off, and this tour skipped. */
  | { type: 'mute'; path: string; now: number }
  /** The switch on the Tutorials page. */
  | { type: 'auto-start-set'; value: boolean };

export type CoachMarksEffect =
  /** Post this report to /api/coach-marks. */
  | { type: 'report'; record: CoachMarkRecord }
  /** Take the person to the page the next step lives on. */
  | { type: 'navigate'; path: string }
  /** PUT the auto-start preference. */
  | { type: 'save-auto-start'; value: boolean };

export interface Transition {
  state: CoachMarksState;
  effects: CoachMarksEffect[];
}

/** One turn reported: the record posted, and the local copy moved by the server's own reducer. */
function report(
  state: CoachMarksState,
  tour: CoachMarkTour,
  event: CoachMarkEvent,
  step: number,
  now: number
): Transition {
  const at = Math.max(now, state.lastReportAt + 1);
  const record: CoachMarkRecord = {
    tourId: tour.id,
    version: tour.version,
    event,
    step,
    stepsTotal: tour.steps.length,
    at,
  };
  const progress = new Map(state.progress);
  progress.set(
    tour.id,
    applyCoachMarkEvent(state.progress.get(tour.id) ?? null, record, new Date(now).toISOString())
  );
  return { state: { ...state, progress, lastReportAt: at }, effects: [{ type: 'report', record }] };
}

/** The tour ends where the person is: closed, and that page offers nothing unasked again. */
function ended(transition: Transition, path: string): Transition {
  return { ...transition, state: { ...transition.state, active: null, endedOn: path } };
}

export function transition(state: CoachMarksState, action: CoachMarksAction): Transition {
  switch (action.type) {
    case 'begin': {
      const begun = { ...state, active: { tour: action.tour, index: 0, manual: action.manual } };
      return report(begun, action.tour, 'viewed', 0, action.now);
    }
    case 'next': {
      const current = state.active;
      if (!current) return { state, effects: [] };
      const { tour, index } = current;
      if (index >= tour.steps.length - 1) {
        return ended(report(state, tour, 'completed', index, action.now), action.path);
      }
      const target = tour.steps[index + 1];
      const moved = { ...state, active: { ...current, index: index + 1 } };
      const reported = report(moved, tour, 'step', index + 1, action.now);
      return target.path && target.path !== action.path
        ? { ...reported, effects: [{ type: 'navigate', path: target.path }, ...reported.effects] }
        : reported;
    }
    case 'back': {
      const current = state.active;
      if (!current || current.index === 0) return { state, effects: [] };
      return { state: { ...state, active: { ...current, index: current.index - 1 } }, effects: [] };
    }
    case 'skip': {
      const current = state.active;
      if (!current) return { state, effects: [] };
      return ended(
        report(state, current.tour, 'dismissed', current.index, action.now),
        action.path
      );
    }
    case 'mute': {
      const muted = transition(state, { type: 'auto-start-set', value: false });
      const skipped = transition(muted.state, { type: 'skip', path: action.path, now: action.now });
      return { state: skipped.state, effects: [...muted.effects, ...skipped.effects] };
    }
    case 'auto-start-set':
      return {
        state: { ...state, autoStart: action.value },
        effects: [{ type: 'save-auto-start', value: action.value }],
      };
  }
}

/** The step on screen, or null with no tour running. */
export function currentStep(state: CoachMarksState) {
  return state.active ? state.active.tour.steps[state.active.index] : null;
}

/** "Don't show tutorials" is offered only on a tour that started unasked — they asked for the rest. */
export function offersMute(state: CoachMarksState): boolean {
  return state.active !== null && !state.active.manual;
}

// --- Starting a tour ---------------------------------------------------------

export interface PendingTour {
  id: string;
  /** From a `?tour=` link: runs on this very page, wherever that is. */
  explicit: boolean;
}

/**
 * The tour the person asked for on another page, if any: a `?tour=` in the
 * address, else what the Tutorials page left in sessionStorage as
 * `<id>|<ms>`. A stored request with no id, or older than a minute, is
 * stale: dropped, and cleared from storage.
 */
export function parsePending(
  query: string | null,
  stored: string | null,
  now: number
): { pending: PendingTour | null; stale: boolean } {
  if (query) return { pending: { id: query, explicit: true }, stale: false };
  if (!stored) return { pending: null, stale: false };
  const [id, at] = stored.split('|');
  const asked = Number(at);
  if (!id || !Number.isFinite(asked) || now - asked > PENDING_TTL_MS) {
    return { pending: null, stale: true };
  }
  return { pending: { id, explicit: false }, stale: false };
}

/** What sessionStorage holds for a tour asked for now. */
export function pendingValue(id: string, now: number): string {
  return `${id}|${now}`;
}

export type StartDecision =
  /** Nothing starts. `clearPending`: a request for a tour that is not theirs, dropped. */
  | { kind: 'none'; clearPending: boolean }
  /** Asked for, but its anchors are not here yet ('/chat/new' on its way to a thread). Nothing else starts. */
  | { kind: 'wait' }
  /** The tour asked for starts now. `clearQuery`: drop `?tour=` from the address. */
  | { kind: 'requested'; tour: CoachMarkTour; clearQuery: boolean }
  /** A tour starts unasked, once the page has painted. */
  | { kind: 'auto'; tour: CoachMarkTour; clearPending: boolean };

/**
 * Whenever the page or the anchors on it change: a requested tour first,
 * else one that starts unasked. With the org's switch off, or a tour
 * already running, nothing starts at all.
 */
export function decideStart(input: {
  tours: readonly CoachMarkTour[];
  enabled: boolean;
  state: CoachMarksState;
  path: string;
  mounted: ReadonlySet<CoachAnchor>;
  isOperator: boolean;
  pending: PendingTour | null;
}): StartDecision {
  const { tours, enabled, state, path, mounted, isOperator, pending } = input;
  if (!enabled || state.active) return { kind: 'none', clearPending: false };

  let clearPending = false;
  if (pending) {
    const requested = tours.find((tour) => tour.id === pending.id);
    if (!requested || !toursFor(tours, isOperator).includes(requested)) {
      clearPending = true;
    } else if (pending.explicit || isEligible(requested, path, mounted)) {
      return { kind: 'requested', tour: requested, clearQuery: pending.explicit };
    } else {
      return { kind: 'wait' };
    }
  }

  if (state.endedOn === path) return { kind: 'none', clearPending };
  const tour = pickAutoStartTour({
    tours,
    path,
    mounted,
    isOperator,
    autoStart: state.autoStart,
    progress: state.progress,
  });
  return tour ? { kind: 'auto', tour, clearPending } : { kind: 'none', clearPending };
}

export type StartTourPlan =
  | { kind: 'none' }
  /** This page is the tour's: it runs at once. */
  | { kind: 'begin'; tour: CoachMarkTour }
  /**
   * Go to the tour's start page, leaving the request in sessionStorage
   * (`path`), or — with no storage — in the address (`fallback`).
   */
  | { kind: 'go'; tour: CoachMarkTour; path: string; fallback: string };

/** Start or Replay on the Tutorials page (or anything else that calls `startTour`). */
export function planStartTour(input: {
  tours: readonly CoachMarkTour[];
  tourId: string;
  enabled: boolean;
  path: string;
  mounted: ReadonlySet<CoachAnchor>;
}): StartTourPlan {
  const tour = input.tours.find((entry) => entry.id === input.tourId);
  if (!tour || !input.enabled) return { kind: 'none' };
  if (isEligible(tour, input.path, input.mounted)) return { kind: 'begin', tour };
  return {
    kind: 'go',
    tour,
    path: tour.startPath,
    fallback: `${tour.startPath}?tour=${encodeURIComponent(tour.id)}`,
  };
}
