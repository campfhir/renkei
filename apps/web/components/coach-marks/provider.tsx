'use client';

/**
 * The coach-mark engine, mounted once in the tenant layout around the nav
 * and the page: it keeps the registry of anchors on screen, decides when
 * a tour starts, walks its steps (across pages when a step says so),
 * draws the current one (overlay.tsx), and reports each turn to the
 * server so the tour is not shown twice and the operator's report has
 * its rows.
 *
 * What it decides — when a tour starts, how Next/Back/Skip/Finish move
 * it, what is reported at which step, how the local rows move — is the
 * step machine in provider.model.ts (tested in provider.model.test.ts),
 * built on lib/coach-marks/select.ts and progress.ts. This component
 * holds the registry, sessionStorage, the timer, the router and the
 * network, and hands the machine what happened.
 *
 * Where a tour belongs is a question the components answer. Each anchor
 * a tour can point at is carried by a component that registers itself
 * here as it mounts (`useCoachAnchor`), so the engine holds the set of
 * anchors on screen at any moment and a tour's `requires` is checked
 * against that set — no selector is ever run against the DOM, and no
 * path pattern has to be kept in step with the routes. A page that
 * renders late registers late, and the engine re-evaluates as it does.
 *
 * Two ways in. A tour starts UNASKED when the page it belongs on is in
 * front of someone who has not settled it at its current version and has
 * auto-start on — one per page load, the first in registry order, half a
 * second after the last anchor settled so the page has painted. Or it
 * starts BY REQUEST: the Tutorials page calls `startTour`, which runs the
 * tour at once if this is already its page, or leaves the id in
 * sessionStorage and navigates to the tour's start path, where the first
 * page that satisfies it picks it up — sessionStorage rather than a
 * query string because '/chat/new' redirects to a fresh thread and a
 * query would be lost on the way; a `?tour=<id>` link is honoured too,
 * for a doc or an email that wants to point at one, and cleaned from the
 * address once read.
 *
 * What the layout passes in — rows and the preference — is the state at
 * the last full page load. A layout does not re-render on a client-side
 * navigation, so this keeps its own copy and moves it as it records: a
 * tour finished on one page must not offer itself on the next.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { CoachAnchor } from '@/lib/coach-marks/anchors';
import { COACH_MARK_TOURS } from '@/lib/coach-marks/tours';
import type { CoachMarkProgressView } from '@/lib/coach-marks/types';
import { CoachAnchorContext, CoachMarkContext, type CoachMarkContextValue } from './context';
import CoachMarkOverlay from './overlay';
import {
  decideStart,
  initCoachMarks,
  offersMute,
  parsePending,
  pendingValue,
  planStartTour,
  transition,
  type CoachMarksAction,
  type CoachMarksState,
  type PendingTour,
} from './provider.model';
import { isVisible } from './visible';
import { reportFetchFailure } from '@/lib/fetch-json';

export { useCoachMarks } from './context';

const PENDING_KEY = 'renkei:coach-mark-pending';
/** Let the page paint, and its anchors settle, before a card lands on it. */
const AUTO_START_DELAY_MS = 500;

function clearPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

function readPending(): PendingTour | null {
  try {
    const { pending, stale } = parsePending(
      new URLSearchParams(window.location.search).get('tour'),
      window.sessionStorage.getItem(PENDING_KEY),
      Date.now()
    );
    if (stale) clearPending();
    return pending;
  } catch {
    return null;
  }
}

function writePending(id: string): boolean {
  try {
    window.sessionStorage.setItem(PENDING_KEY, pendingValue(id, Date.now()));
    return true;
  } catch {
    return false;
  }
}

async function saveAutoStart(value: boolean): Promise<boolean> {
  try {
    const response = await fetch(`/api/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coachMarks: { autoStart: value } }),
    });
    if (!response.ok) {
      reportFetchFailure(
        'PUT',
        '/api/preferences',
        response.status,
        `Request failed (${response.status})`
      );
    }
    return response.ok;
  } catch (error) {
    reportFetchFailure('PUT', '/api/preferences', 0, 'Could not reach the server', error);
    return false;
  }
}

export default function CoachMarkProvider({
  isOperator,
  enabled,
  autoStart: initialAutoStart,
  progress: initialProgress,
  children,
}: {
  isOperator: boolean;
  /** The org's switch. Off, nothing starts — unasked or by hand — and nothing draws. */
  enabled: boolean;
  autoStart: boolean;
  progress: CoachMarkProgressView[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // The step machine's state, in a ref as well as in React state, so two
  // presses before a render each see the other's result.
  const [state, setState] = useState<CoachMarksState>(() =>
    initCoachMarks({ autoStart: initialAutoStart, progress: initialProgress })
  );
  const stateRef = useRef(state);

  // The registry: anchor → the elements on the page carrying it (the menu
  // carries each of its own twice, drawer and column). Kept in a ref so
  // registering is cheap; `anchorsVersion` is what tells React the set
  // moved, and `mounted` is the set the rules read.
  const registry = useRef(new Map<CoachAnchor, Set<Element>>());
  const [anchorsVersion, setAnchorsVersion] = useState(0);
  const registerAnchor = useCallback((name: CoachAnchor, element: Element) => {
    let elements = registry.current.get(name);
    if (!elements) {
      elements = new Set();
      registry.current.set(name, elements);
    }
    elements.add(element);
    setAnchorsVersion((version) => version + 1);
    return () => {
      const current = registry.current.get(name);
      if (!current) return;
      current.delete(element);
      if (current.size === 0) registry.current.delete(name);
      setAnchorsVersion((version) => version + 1);
    };
  }, []);
  const mounted = useMemo<ReadonlySet<CoachAnchor>>(
    () => new Set(registry.current.keys()),
    // The ref holds the truth; the version is what invalidates this view of it.
    [anchorsVersion]
  );
  /** The element a step's spotlight goes on: the anchor's first element that is on screen. */
  const resolveAnchor = useCallback((name: CoachAnchor): Element | null => {
    for (const element of registry.current.get(name) ?? []) {
      if (element.isConnected && isVisible(element)) return element;
    }
    return null;
  }, []);

  /**
   * Hand the machine what happened and carry out what it answers: reports
   * leave at once (keepalive, so a Finish followed at once by a navigation
   * still lands), the router moves, the preference is saved. Returns the
   * save, when the action made one.
   */
  const run = useCallback(
    (action: CoachMarksAction): Promise<boolean> | null => {
      const result = transition(stateRef.current, action);
      stateRef.current = result.state;
      setState(result.state);
      let saved: Promise<boolean> | null = null;
      for (const effect of result.effects) {
        switch (effect.type) {
          case 'report':
            void fetch(`/api/coach-marks`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(effect.record),
              keepalive: true,
            }).catch(() => {
              // A lost report is a lost data point, never a lost tour.
            });
            break;
          case 'navigate':
            router.push(effect.path);
            break;
          case 'save-auto-start':
            saved = saveAutoStart(effect.value);
            break;
        }
      }
      return saved;
    },
    [router]
  );

  // Whenever the page or the anchors on it change: a requested tour
  // first, else one that starts unasked.
  useEffect(() => {
    const idle = enabled && !stateRef.current.active;
    const decision = decideStart({
      tours: COACH_MARK_TOURS,
      enabled,
      state: stateRef.current,
      path: pathname,
      mounted,
      isOperator,
      pending: idle ? readPending() : null,
    });
    switch (decision.kind) {
      case 'none':
        if (decision.clearPending) clearPending();
        return;
      case 'wait':
        return;
      case 'requested':
        clearPending();
        // Drop `?tour=` from the address through the browser's own history,
        // which Next keeps in step with: a router navigation here raced a
        // page that was itself redirecting ('/chat/new') and tripped React.
        if (decision.clearQuery) {
          window.history.replaceState(window.history.state, '', pathname);
        }
        run({ type: 'begin', tour: decision.tour, manual: true, now: Date.now() });
        return;
      case 'auto': {
        if (decision.clearPending) clearPending();
        const tour = decision.tour;
        const timer = setTimeout(() => {
          if (!stateRef.current.active)
            run({ type: 'begin', tour, manual: false, now: Date.now() });
        }, AUTO_START_DELAY_MS);
        return () => clearTimeout(timer);
      }
    }
    // `progress` and `autoStart` are read when the page or its anchors
    // change, not re-run as they move — a tour just finished here must not
    // restart.
  }, [pathname, mounted, isOperator, enabled, run]);

  const next = useCallback(
    () => void run({ type: 'next', path: pathname, now: Date.now() }),
    [run, pathname]
  );
  const back = useCallback(() => void run({ type: 'back' }), [run]);
  const skip = useCallback(
    () => void run({ type: 'skip', path: pathname, now: Date.now() }),
    [run, pathname]
  );
  const mute = useCallback(
    () => void run({ type: 'mute', path: pathname, now: Date.now() }),
    [run, pathname]
  );
  const setAutoStart = useCallback(
    async (value: boolean): Promise<boolean> =>
      (await run({ type: 'auto-start-set', value })) ?? false,
    [run]
  );

  const startTour = useCallback(
    (tourId: string) => {
      const plan = planStartTour({
        tours: COACH_MARK_TOURS,
        tourId,
        enabled,
        path: pathname,
        mounted,
      });
      if (plan.kind === 'none') return;
      if (plan.kind === 'begin') {
        run({ type: 'begin', tour: plan.tour, manual: true, now: Date.now() });
        return;
      }
      // No storage: fall back to the query, which the start page reads too.
      router.push(writePending(plan.tour.id) ? plan.path : plan.fallback);
    },
    [pathname, mounted, enabled, run, router]
  );

  const { active, autoStart, progress } = state;
  const value = useMemo<CoachMarkContextValue>(
    () => ({
      active: active ? { tourId: active.tour.id, index: active.index } : null,
      activeTarget: active ? (active.tour.steps[active.index].target ?? null) : null,
      enabled,
      autoStart,
      progress,
      mounted,
      startTour,
      setAutoStart,
    }),
    [active, enabled, autoStart, progress, mounted, startTour, setAutoStart]
  );

  return (
    <CoachAnchorContext.Provider value={registerAnchor}>
      <CoachMarkContext.Provider value={value}>
        {children}
        {active && enabled ? (
          <CoachMarkOverlay
            tour={active.tour}
            index={active.index}
            resolveAnchor={resolveAnchor}
            anchorsVersion={anchorsVersion}
            onNext={next}
            onBack={back}
            onSkip={skip}
            onMute={offersMute(state) ? mute : null}
          />
        ) : null}
      </CoachMarkContext.Provider>
    </CoachAnchorContext.Provider>
  );
}
