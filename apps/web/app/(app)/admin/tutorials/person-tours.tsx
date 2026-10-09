'use client';

/**
 * The Tours cell of the report's By person table: a chip per tour the
 * person has seen, coloured by how their latest pass ended. With sixty
 * tours in the registry a diligent person's row would run to three lines
 * of chips, so the cell shows the first few and a "+n" that opens the
 * whole list as a table — one row per tour, with the step reached and
 * the counters the chip's hover text used to carry.
 */

import { useState } from 'react';
import Modal from '@/components/modal';
import LocalTime from '@/components/local-time';
import type { CoachMarkStateLabel } from '@/lib/coach-marks/select';

export interface PersonTourRow {
  id: string;
  title: string;
  area: string;
  label: CoachMarkStateLabel;
  stepReached: number;
  stepsTotal: number;
  viewCount: number;
  completedCount: number;
  dismissedCount: number;
  lastViewedAt: string;
}

/** How many chips sit in the row before the rest fold behind "+n". */
export const CHIPS_SHOWN = 4;

const BADGE: Record<CoachMarkStateLabel, string> = {
  'Not started': 'text-gray-400 dark:text-gray-600',
  'In progress': 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  Completed: 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300',
  Skipped: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  Updated: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
};

function Chip({ row }: { row: PersonTourRow }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[row.label]}`}
      title={`${row.label} · step ${row.stepReached + 1} of ${row.stepsTotal}`}
    >
      {row.title}
    </span>
  );
}

export default function PersonTours({ name, tours }: { name: string; tours: PersonTourRow[] }) {
  const [open, setOpen] = useState(false);
  const shown = tours.slice(0, CHIPS_SHOWN);
  const hidden = tours.length - shown.length;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((row) => (
        <Chip key={row.id} row={row} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`All ${tours.length} tours for ${name}`}
          data-testid="person-tours-more"
          className="whitespace-nowrap rounded-full border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
        >
          +{hidden}
        </button>
      )}
      {open && (
        <Modal title={`${name} · ${tours.length} tours`} size="wide" onClose={() => setOpen(false)}>
          <div className="max-h-[70vh] overflow-auto" data-testid="person-tours-dialog">
            {/* A phone gets one card per tour; eight columns do not fit a narrow modal. */}
            <ul className="divide-y divide-gray-100 sm:hidden dark:divide-gray-900">
              {tours.map((row) => (
                <li key={row.id} data-testid="person-tour" className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-medium">{row.title}</span>
                    <Chip row={{ ...row, title: row.label }} />
                  </div>
                  <p className="text-xs text-gray-500">
                    {row.area} · step {row.stepReached + 1} of {row.stepsTotal} · viewed{' '}
                    {row.viewCount}×, completed {row.completedCount}×, skipped {row.dismissedCount}×
                    {' · '}
                    <LocalTime at={row.lastViewedAt} />
                  </p>
                </li>
              ))}
            </ul>
            <table className="hidden w-full text-sm sm:table">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800">
                  <th className="px-3 py-2 font-semibold">Tour</th>
                  <th className="px-3 py-2 font-semibold">Area</th>
                  <th className="px-3 py-2 font-semibold">State</th>
                  <th className="px-3 py-2 text-right font-semibold">Step</th>
                  <th className="px-3 py-2 text-right font-semibold">Viewed</th>
                  <th className="px-3 py-2 text-right font-semibold">Completed</th>
                  <th className="px-3 py-2 text-right font-semibold">Skipped</th>
                  <th className="px-3 py-2 font-semibold">Last viewed</th>
                </tr>
              </thead>
              <tbody>
                {tours.map((row) => (
                  <tr
                    key={row.id}
                    data-testid="person-tour"
                    className="border-b border-gray-100 last:border-0 dark:border-gray-900"
                  >
                    <td className="px-3 py-2 font-medium">{row.title}</td>
                    <td className="px-3 py-2 text-gray-500">{row.area}</td>
                    <td className="px-3 py-2">
                      <Chip row={{ ...row, title: row.label }} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.stepReached + 1} of {row.stepsTotal}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.viewCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.completedCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.dismissedCount}</td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      <LocalTime at={row.lastViewedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
