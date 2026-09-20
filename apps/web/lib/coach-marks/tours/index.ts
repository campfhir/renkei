import type { CoachMarkTour } from '../types';
import { GETTING_STARTED_TOURS } from './getting-started';
import { WORKSPACE_TOURS } from './workspace';
import { CHAT_TOURS } from './chat';
import { ACCOUNT_TOURS } from './account';
import { CONNECTOR_TOURS } from './connectors';
import { ORGANIZATION_TOURS } from './organization';

/**
 * The registry: every tour this build ships, in the order they are offered.
 * One file per area of the app; this is the sum, in the order the Tutorials
 * page lists them.
 *
 * Order matters twice. On a page that several auto-start tours belong on,
 * the first unseen one wins (and only one runs per page load — the next
 * waits for the next visit). And the Tutorials page lists them in this
 * order within each area, so the welcome tour leads.
 *
 * Copy is product text: short, second person, one idea per step. A step's
 * body should still make sense with the spotlight missing, because on a
 * phone the menu column is a drawer and the card falls back to the centre.
 *
 * Where a tour belongs is said by its `requires`: the anchors that have to
 * be mounted. The chat tour needs the composer, so it starts on a thread
 * and nowhere else, and only once the thread has rendered — no path
 * pattern, no selector. Adding a tour for a new feature: anchors on the
 * feature's elements (anchors.ts, `useCoachAnchor`), a tour in its area's
 * file naming them, a row in docs/coach-mark-coverage.md, and the tour
 * test does the rest. Reworking a feature its tour describes: bump
 * `version`.
 */
export const COACH_MARK_TOURS: CoachMarkTour[] = [
  ...GETTING_STARTED_TOURS,
  ...WORKSPACE_TOURS,
  ...CHAT_TOURS,
  ...ACCOUNT_TOURS,
  ...CONNECTOR_TOURS,
  ...ORGANIZATION_TOURS,
];

export function tourById(id: string): CoachMarkTour | null {
  return COACH_MARK_TOURS.find((tour) => tour.id === id) ?? null;
}
