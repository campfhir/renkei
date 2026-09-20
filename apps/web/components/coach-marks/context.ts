'use client';

/**
 * The two contexts the coach-mark engine publishes, apart so that a
 * component which only carries an anchor does not re-render every time a
 * tour advances.
 *
 * `CoachAnchorContext` is the registry: a component that carries an anchor
 * (`useCoachAnchor`) tells the engine "I am `agents-new`, here is my
 * element" as it mounts, and takes it back as it unmounts. The engine
 * decides where a tour belongs from that set — never from a selector
 * query, never from a path pattern — and the overlay finds a step's
 * target in it. The function is stable for the life of the provider.
 *
 * `CoachMarkContext` is the engine's state and controls: what is running,
 * the person's rows and preference, and the way to start a tour or flip
 * the preference. The Tutorials page reads it.
 */

import { createContext, useContext } from 'react';
import type { CoachAnchor } from '@/lib/coach-marks/anchors';
import type { CoachMarkProgressView } from '@/lib/coach-marks/types';

/** Register an element for an anchor; the return unregisters it. */
export type RegisterAnchor = (name: CoachAnchor, element: Element) => () => void;

export const CoachAnchorContext = createContext<RegisterAnchor | null>(null);

export interface CoachMarkContextValue {
  /** The tour on screen, if any. */
  active: { tourId: string; index: number } | null;
  /** The org's switch: off, no tour runs for anyone and the Tutorials door is closed. */
  enabled: boolean;
  /** Whether tours may start unasked for this person. */
  autoStart: boolean;
  /** The person's rows, as this engine last knew them. */
  progress: ReadonlyMap<string, CoachMarkProgressView>;
  /** The anchors currently on screen — what the engine goes by. */
  mounted: ReadonlySet<CoachAnchor>;
  /** Start a tour by hand: runs it here if this is its page, else goes there first. */
  startTour: (tourId: string) => void;
  /** Flip the preference, here and on the server. */
  setAutoStart: (value: boolean) => Promise<boolean>;
}

export const CoachMarkContext = createContext<CoachMarkContextValue | null>(null);

export function useCoachMarks(): CoachMarkContextValue {
  const value = useContext(CoachMarkContext);
  if (!value) throw new Error('useCoachMarks must be used inside CoachMarkProvider');
  return value;
}
