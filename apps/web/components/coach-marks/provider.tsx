'use client';

/**
 * The coach-mark engine, mounted once in the tenant layout around the nav
 * and the page: it keeps the registry of anchors on screen, decides when
 * a tour starts, walks its steps (across pages when a step says so),
 * draws the current one (overlay.tsx), and reports each turn to the
 * server so the tour is not shown twice and the operator's report has
 * its rows.
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
import { applyCoachMarkEvent, type CoachMarkRecord } from '@/lib/coach-marks/progress';
import {
  isEligible,
  pickAutoStartTour,
  slugRelativePath,
  toursFor,
} from '@/lib/coach-marks/select';
import { COACH_MARK_TOURS, tourById } from '@/lib/coach-marks/tours';
import type { CoachMarkEvent, CoachMarkProgressView, CoachMarkTour } from '@/lib/coach-marks/types';
import { CoachAnchorContext, CoachMarkContext, type CoachMarkContextValue } from './context';
import CoachMarkOverlay from './overlay';
import { isVisible } from './visible';

export { useCoachMarks } from './context';

const PENDING_KEY = 'renkei:coach-mark-pending';
/** A request older than this is stale — the person went elsewhere — and is dropped. */
const PENDING_TTL_MS = 60_000;
/** Let the page paint, and its anchors settle, before a card lands on it. */
const AUTO_START_DELAY_MS = 500;

interface Active {
  tour: CoachMarkTour;
  index: number;
  /** Started from the Tutorials page or a link, not unasked. */
  manual: boolean;
}

interface Pending {
  id: string;
  /** From a `?tour=` link: runs on this very page, wherever that is. */
  explicit: boolean;
}

function clearPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

function readPending(): Pending | null {
  try {
    const query = new URLSearchParams(window.location.search).get('tour');
    if (query) return { id: query, explicit: true };
    const stored = window.sessionStorage.getItem(PENDING_KEY);
    if (!stored) return null;
    const [id, at] = stored.split('|');
    if (!id || Date.now() - Number(at) > PENDING_TTL_MS) {
      clearPending();
      return null;
    }
    return { id, explicit: false };
  } catch {
    return null;
  }
}

function writePending(id: string): boolean {
  try {
    window.sessionStorage.setItem(PENDING_KEY, `${id}|${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

export default function CoachMarkProvider({
  slug,
  tenantId,
  isOperator,
  autoStart: initialAutoStart,
  progress: initialProgress,
  children,
}: {
  slug: string;
  tenantId: string;
  isOperator: boolean;
  autoStart: boolean;
  progress: CoachMarkProgressView[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [active, setActive] = useState<Active | null>(null);
  const [autoStart, setAutoStartState] = useState(initialAutoStart);
  const [progress, setProgress] = useState<ReadonlyMap<string, CoachMarkProgressView>>(
    () => new Map(initialProgress.map((row) => [row.tourId, row]))
  );
  // Where the last tour ended: nothing starts unasked there again until
  // the person moves on.
  const endedOnRef = useRef<string | null>(null);
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;
  // Each report carries the moment it happened, strictly increasing within
  // this tab, so they can leave at once and land in any order: the server
  // ignores one older than the last it applied. (Waiting for each response
  // before sending the next was tried; a Skip right behind a slow 'viewed'
  // had not even left when the page unloaded, and was lost.)
  const lastReportAt = useRef(0);

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

  const record = useCallback(
    (tour: CoachMarkTour, event: CoachMarkEvent, step: number) => {
      const at = Math.max(Date.now(), lastReportAt.current + 1);
      lastReportAt.current = at;
      const body: CoachMarkRecord = {
        tourId: tour.id,
        version: tour.version,
        event,
        step,
        stepsTotal: tour.steps.length,
        at,
      };
      // The same reducer the server runs, so the local copy agrees with the
      // row it will read on the next full load.
      setProgress((current) => {
        const next = new Map(current);
        next.set(
          tour.id,
          applyCoachMarkEvent(current.get(tour.id) ?? null, body, new Date().toISOString())
        );
        return next;
      });
      // keepalive: a Finish followed at once by a navigation still lands.
      void fetch(`/api/tenant/${tenantId}/coach-marks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {
        // A lost report is a lost data point, never a lost tour.
      });
    },
    [tenantId]
  );

  const begin = useCallback(
    (tour: CoachMarkTour, manual: boolean) => {
      setActive({ tour, index: 0, manual });
      record(tour, 'viewed', 0);
    },
    [record]
  );

  const end = useCallback(() => {
    endedOnRef.current = pathname;
    setActive(null);
  }, [pathname]);

  // Whenever the page or the anchors on it change: a requested tour
  // first, else one that starts unasked.
  useEffect(() => {
    if (activeRef.current) return;
    const path = slugRelativePath(pathname, slug);

    const pending = readPending();
    if (pending) {
      const requested = tourById(pending.id);
      if (!requested || !toursFor(COACH_MARK_TOURS, isOperator).includes(requested)) {
        clearPending();
      } else if (pending.explicit || isEligible(requested, path, mounted)) {
        clearPending();
        if (pending.explicit) router.replace(pathname);
        begin(requested, true);
        return;
      } else {
        // Asked for, but its anchors are not here yet — '/chat/new' on the
        // way to the thread it makes. It waits; nothing else starts.
        return;
      }
    }

    if (endedOnRef.current === pathname) return;
    const tour = pickAutoStartTour({
      tours: COACH_MARK_TOURS,
      path,
      mounted,
      isOperator,
      autoStart,
      progress,
    });
    if (!tour) return;
    const timer = setTimeout(() => {
      if (!activeRef.current) begin(tour, false);
    }, AUTO_START_DELAY_MS);
    return () => clearTimeout(timer);
    // `progress` and `autoStart` are read when the page or its anchors
    // change, not re-run as they move — a tour just finished here must not
    // restart.
  }, [pathname, mounted, slug, isOperator, begin, router]);

  const next = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    const { tour, index } = current;
    if (index >= tour.steps.length - 1) {
      record(tour, 'completed', index);
      end();
      return;
    }
    const target = tour.steps[index + 1];
    if (target.path && slugRelativePath(pathname, slug) !== target.path) {
      router.push(`/${slug}${target.path}`);
    }
    setActive({ ...current, index: index + 1 });
    record(tour, 'step', index + 1);
  }, [record, end, pathname, slug, router]);

  const back = useCallback(() => {
    const current = activeRef.current;
    if (!current || current.index === 0) return;
    setActive({ ...current, index: current.index - 1 });
  }, []);

  const skip = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    record(current.tour, 'dismissed', current.index);
    end();
  }, [record, end]);

  const setAutoStart = useCallback(
    async (value: boolean): Promise<boolean> => {
      setAutoStartState(value);
      try {
        const response = await fetch(`/api/tenant/${tenantId}/preferences`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ coachMarks: { autoStart: value } }),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    [tenantId]
  );

  const mute = useCallback(() => {
    void setAutoStart(false);
    skip();
  }, [setAutoStart, skip]);

  const startTour = useCallback(
    (tourId: string) => {
      const tour = tourById(tourId);
      if (!tour) return;
      if (isEligible(tour, slugRelativePath(pathname, slug), mounted)) {
        begin(tour, true);
        return;
      }
      if (!writePending(tour.id)) {
        // No storage: fall back to the query, which the start page reads too.
        router.push(`/${slug}${tour.startPath}?tour=${encodeURIComponent(tour.id)}`);
        return;
      }
      router.push(`/${slug}${tour.startPath}`);
    },
    [pathname, slug, mounted, begin, router]
  );

  const value = useMemo<CoachMarkContextValue>(
    () => ({
      active: active ? { tourId: active.tour.id, index: active.index } : null,
      autoStart,
      progress,
      mounted,
      startTour,
      setAutoStart,
    }),
    [active, autoStart, progress, mounted, startTour, setAutoStart]
  );

  return (
    <CoachAnchorContext.Provider value={registerAnchor}>
      <CoachMarkContext.Provider value={value}>
        {children}
        {active ? (
          <CoachMarkOverlay
            tour={active.tour}
            index={active.index}
            resolveAnchor={resolveAnchor}
            anchorsVersion={anchorsVersion}
            onNext={next}
            onBack={back}
            onSkip={skip}
            onMute={active.manual ? null : mute}
          />
        ) : null}
      </CoachMarkContext.Provider>
    </CoachAnchorContext.Provider>
  );
}
