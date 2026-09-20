'use client';

/**
 * The coach-mark engine, mounted once in the tenant layout around the nav
 * and the page: it decides when a tour starts, walks its steps (across
 * pages when a step says so), draws the current one (overlay.tsx), and
 * reports each turn to the server so the tour is not shown twice and the
 * operator's report has its rows.
 *
 * Two ways in. A tour starts UNASKED when the person lands on a page it
 * matches, has not settled it at its current version, and has auto-start
 * on — one per page load, the first in registry order, half a second
 * after arrival so the page has painted (select.ts holds the rule). Or it
 * starts BY REQUEST: the Tutorials page calls `startTour`, which leaves
 * the id in sessionStorage and navigates to the tour's start path, where
 * this picks it up — sessionStorage rather than a query string because
 * '/chat/new' redirects to a fresh thread and a query would be lost on
 * the way; a `?tour=<id>` link is honoured too, for a doc or an email
 * that wants to point at one, and cleaned from the address once read.
 *
 * What the layout passes in — rows and the preference — is the state at
 * the last full page load. A layout does not re-render on a client-side
 * navigation, so this keeps its own copy and moves it as it records: a
 * tour finished on one page must not offer itself on the next.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { applyCoachMarkEvent, type CoachMarkRecord } from '@/lib/coach-marks/progress';
import { pickAutoStartTour, slugRelativePath, toursFor } from '@/lib/coach-marks/select';
import { COACH_MARK_TOURS, tourById } from '@/lib/coach-marks/tours';
import type { CoachMarkEvent, CoachMarkProgressView, CoachMarkTour } from '@/lib/coach-marks/types';
import CoachMarkOverlay from './overlay';

const PENDING_KEY = 'renkei:coach-mark-pending';
/** A request older than this is stale — the person went elsewhere — and is dropped. */
const PENDING_TTL_MS = 60_000;
/** Let the page paint before a card lands on it. */
const AUTO_START_DELAY_MS = 500;

interface Active {
  tour: CoachMarkTour;
  index: number;
  /** Started from the Tutorials page or a link, not unasked. */
  manual: boolean;
}

interface CoachMarkContextValue {
  /** The tour on screen, if any. */
  active: { tourId: string; index: number } | null;
  /** Whether tours may start unasked for this person. */
  autoStart: boolean;
  /** The person's rows, as this engine last knew them. */
  progress: ReadonlyMap<string, CoachMarkProgressView>;
  /** Start a tour by hand: navigates to where it begins and runs it there. */
  startTour: (tourId: string) => void;
  /** Flip the preference, here and on the server. */
  setAutoStart: (value: boolean) => Promise<boolean>;
}

const CoachMarkContext = createContext<CoachMarkContextValue | null>(null);

export function useCoachMarks(): CoachMarkContextValue {
  const value = useContext(CoachMarkContext);
  if (!value) throw new Error('useCoachMarks must be used inside CoachMarkProvider');
  return value;
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
  // Reports go out one at a time, in order: a 'step' still in flight when
  // 'completed' leaves must not land second and read as the later word.
  const reportQueue = useRef<Promise<void>>(Promise.resolve());

  const record = useCallback(
    (tour: CoachMarkTour, event: CoachMarkEvent, step: number) => {
      const body: CoachMarkRecord = {
        tourId: tour.id,
        version: tour.version,
        event,
        step,
        stepsTotal: tour.steps.length,
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
      reportQueue.current = reportQueue.current.then(() =>
        fetch(`/api/tenant/${tenantId}/coach-marks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        })
          .then(() => undefined)
          .catch(() => {
            // A lost report is a lost data point, never a lost tour.
          })
      );
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

  // On arrival at a page: a requested tour first, else one that starts unasked.
  useEffect(() => {
    if (activeRef.current) return;
    const path = slugRelativePath(pathname, slug);

    const pending = readPending();
    if (pending) {
      const requested = tourById(pending.id);
      if (!requested || !toursFor(COACH_MARK_TOURS, isOperator).includes(requested)) {
        clearPending();
      } else if (pending.explicit || requested.matches(path)) {
        clearPending();
        if (pending.explicit) router.replace(pathname);
        begin(requested, true);
        return;
      } else {
        // Asked for, but this is not its page yet — '/chat/new' on the way
        // to the thread it makes. It waits; nothing else starts meanwhile.
        return;
      }
    }

    if (endedOnRef.current === pathname) return;
    const tour = pickAutoStartTour({
      tours: COACH_MARK_TOURS,
      path,
      isOperator,
      autoStart,
      progress,
    });
    if (!tour) return;
    const timer = setTimeout(() => {
      if (!activeRef.current) begin(tour, false);
    }, AUTO_START_DELAY_MS);
    return () => clearTimeout(timer);
    // `progress` and `autoStart` are read when the path changes, not
    // re-run as they move — a tour just finished here must not restart.
  }, [pathname, slug, isOperator, begin, router]);

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
      const path = slugRelativePath(pathname, slug);
      if (tour.matches(path)) {
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
    [pathname, slug, begin, router]
  );

  const value = useMemo<CoachMarkContextValue>(
    () => ({
      active: active ? { tourId: active.tour.id, index: active.index } : null,
      autoStart,
      progress,
      startTour,
      setAutoStart,
    }),
    [active, autoStart, progress, startTour, setAutoStart]
  );

  return (
    <CoachMarkContext.Provider value={value}>
      {children}
      {active ? (
        <CoachMarkOverlay
          tour={active.tour}
          index={active.index}
          onNext={next}
          onBack={back}
          onSkip={skip}
          onMute={active.manual ? null : mute}
        />
      ) : null}
    </CoachMarkContext.Provider>
  );
}
