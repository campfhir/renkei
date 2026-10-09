/**
 * A small colored status badge — state (open/merged/success/failure…),
 * counts, on/off — shared across the Code pages' cards and detail
 * pages instead of each one carrying its own copy.
 */

import type { ReactNode } from 'react';

const TONES = {
  green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  gray: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
} as const;

export type PillTone = keyof typeof TONES;

export default function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
