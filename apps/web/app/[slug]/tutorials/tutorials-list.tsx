'use client';

/**
 * The tours as a list of cards, and the auto-start switch above them.
 *
 * Everything here goes through the coach-mark engine's context rather
 * than its own fetches: starting a tour is the engine's job (it navigates
 * to where the tour begins and runs it there), and the switch has to
 * change the engine's own copy of the preference as well as the server's,
 * or the next page would still start a tour the person just turned off.
 * The rows the server rendered this page from are the starting point; the
 * engine's copy takes over as soon as it has moved (a tour finished since
 * this page loaded, in another tab of the same session, does not count —
 * a reload shows it).
 */

import { useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useCoachMarks } from '@/components/coach-marks/provider';
import { stateLabel, type CoachMarkStateLabel } from '@/lib/coach-marks/select';
import type { CoachMarkProgressView } from '@/lib/coach-marks/types';
import LocalTime from '@/components/local-time';

export interface TourListing {
  id: string;
  version: number;
  title: string;
  description: string;
  steps: number;
  audience: 'everyone' | 'operators';
}

const BADGE: Record<CoachMarkStateLabel, string> = {
  'Not started': 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  'In progress': 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  Completed: 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300',
  Skipped: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  Updated: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
};

export default function TutorialsList({
  tours,
  progress: initialProgress,
  autoStart: initialAutoStart,
}: {
  tours: TourListing[];
  progress: CoachMarkProgressView[];
  autoStart: boolean;
}) {
  const engine = useCoachMarks();
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle');
  // The engine's copy once it has moved; the server's until then.
  const [touched, setTouched] = useState(false);
  const autoStart = touched ? engine.autoStart : initialAutoStart;

  async function toggle() {
    setTouched(true);
    setStatus('saving');
    const saved = await engine.setAutoStart(!autoStart);
    setStatus(saved ? 'idle' : 'failed');
  }

  function rowFor(tour: TourListing): CoachMarkProgressView | undefined {
    return engine.progress.get(tour.id) ?? initialProgress.find((row) => row.tourId === tour.id);
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="tutorials-auto-heading"
        className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="tutorials-auto-heading" className="font-semibold">
              Show tours automatically
            </h2>
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
              A page&apos;s tour starts on its own the first time you visit. Turn this off and tours
              only run when you start one below.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              aria-label="Show tours automatically"
              checked={autoStart}
              disabled={status === 'saving'}
              onChange={() => void toggle()}
              className="h-4 w-4"
            />
            {autoStart ? 'On' : 'Off'}
          </label>
        </div>
        {status === 'failed' ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">
            Could not save. The switch is set for this visit only.
          </p>
        ) : null}
      </section>

      <ul className="space-y-3" aria-label="Tours">
        {tours.map((tour) => {
          const row = rowFor(tour);
          const label = stateLabel(row, tour);
          const taken = row !== undefined;
          return (
            <li
              key={tour.id}
              data-testid={`tutorial-${tour.id}`}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{tour.title}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[label]}`}
                    >
                      {label}
                    </span>
                    {tour.audience === 'operators' ? (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-950/60 dark:text-violet-300">
                        Operators
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    {tour.description}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {tour.steps} {tour.steps === 1 ? 'step' : 'steps'}
                    {row?.completedAt ? (
                      <>
                        {' · completed '}
                        <LocalTime at={row.completedAt} format="date" />
                      </>
                    ) : row?.dismissedAt ? (
                      <>
                        {' · skipped '}
                        <LocalTime at={row.dismissedAt} format="date" />
                        {` at step ${row.stepReached + 1} of ${row.stepsTotal}`}
                      </>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => engine.startTour(tour.id)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <Icon path={ICONS.play} className="h-3.5 w-3.5" />
                  {taken ? 'Replay' : 'Start'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
