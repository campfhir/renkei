import type { CoachAnchor } from './anchors';

/**
 * What a tour IS — pure shapes, no React and no database, so the registry,
 * the selection rules and the progress reducer can each be unit-tested on
 * their own and the worker could one day read the registry too.
 */

/** Which side of its target a step's card prefers; 'auto' picks the roomiest. */
export type CoachMarkPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

export interface CoachMarkStep {
  /** Stable within the tour; recorded nowhere, used for React keys and tests. */
  id: string;
  title: string;
  /** Plain prose. One or two sentences: a coach mark is a caption, not a page. */
  body: string;
  /**
   * The anchor to spotlight. Absent, the card sits centred with no
   * spotlight — an intro or a wrap-up. A target that is not on the page
   * (a button only some orgs have) degrades to the same. One the menu
   * carries is brought on screen for the step: the drawer opens on a
   * phone, a hidden column comes back on a desktop.
   */
  target?: CoachAnchor;
  placement?: CoachMarkPlacement;
  /**
   * The slug-relative path this step lives on, when it differs from the
   * tour's start path. The engine navigates there when the step is
   * reached — a tour may walk through a workflow across pages.
   */
  path?: string;
}

/** How the Tutorials page groups the tours, in this order. */
export const COACH_MARK_AREAS = [
  'Getting started',
  'Workspace',
  'Chat',
  'Your account',
  'Connectors',
  'Organization',
] as const;
export type CoachMarkArea = (typeof COACH_MARK_AREAS)[number];

export interface CoachMarkTour {
  /** The registry key, recorded in `coach_mark_progress.tour_id`. Never reuse one. */
  id: string;
  /** Which heading it sits under on the Tutorials page. */
  area: CoachMarkArea;
  /**
   * Bump when the tour changes enough that people who finished the old one
   * should see it again — a reworked feature. Progress at an older version
   * reads as unseen for auto-start, and as "Updated" on the Tutorials page.
   */
  version: number;
  title: string;
  /** For the Tutorials page: what this tour teaches, in a sentence. */
  description: string;
  /** Slug-relative: '/' for home, '/agents'… Replay goes here. */
  startPath: string;
  /**
   * Whether the tour may start unasked when someone who has not seen it
   * lands on a page it belongs on. Off means Tutorials-page only — for a
   * tour that is reference material rather than a first-run greeting.
   */
  autoStart: boolean;
  /**
   * The anchors that must be on screen for this tour to belong here. The
   * components carrying them register with the engine as they mount
   * (`useCoachAnchor`), so "is this the agents page, and has it rendered"
   * is a set lookup — never a selector query, never a path pattern. A
   * tour with no requirements belongs everywhere `matches` allows.
   */
  requires?: CoachAnchor[];
  /**
   * An extra gate on the slug-relative path, for a tour whose anchors
   * alone do not pin it down (the nav's are on every page). Rarely needed.
   */
  matches?: (path: string) => boolean;
  /** Who may see it at all; an operator-only tour never appears for anyone else. */
  audience: 'everyone' | 'operators';
  steps: CoachMarkStep[];
}

/** The latest outcome a person's row for a tour records. */
export type CoachMarkStatus = 'viewed' | 'completed' | 'dismissed';

/** What the browser and the pages need to know about one person's row. */
export interface CoachMarkProgressView {
  tourId: string;
  version: number;
  status: CoachMarkStatus;
  /** The furthest 0-based step reached this time through. */
  stepReached: number;
  stepsTotal: number;
  viewCount: number;
  completedCount: number;
  dismissedCount: number;
  /** ISO timestamps. */
  firstViewedAt: string;
  lastViewedAt: string;
  completedAt: string | null;
  dismissedAt: string | null;
  /** The browser's clock on the latest report applied, ISO; older reports are stragglers. */
  reportedAt: string;
}

/** What the browser reports as a tour runs. */
export type CoachMarkEvent = 'viewed' | 'step' | 'completed' | 'dismissed';
