'use client';

/**
 * The terminal (end marker) node card. Color says the result at a glance —
 * green finish, red failure, amber "nothing to do" — and badges say which
 * notification channels fire when the run ends here.
 */

import type { TerminalStep } from '@renkei/agents';
import { FixedPill, FixedRail } from './fixed-marker';

const RESULT_WORDING: Record<TerminalStep['result'], string> = {
  success: 'Finishes the run',
  failure: 'Fails the run',
  stop: 'Stops — nothing to do',
};

export function TerminalNode({
  terminal,
  ordinal,
  selected,
  issueCount,
  onSelect,
}: {
  terminal: TerminalStep;
  ordinal: number;
  selected: boolean;
  issueCount: number;
  onSelect: () => void;
}) {
  const tone =
    terminal.result === 'failure'
      ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
      : terminal.result === 'stop'
        ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40'
        : 'border-green-300 bg-green-50 dark:border-green-900 dark:bg-green-950/40';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Edit ending: ${terminal.name || 'unnamed'}`}
      className={`relative w-64 rounded-lg border p-3 text-left shadow-sm transition-shadow hover:shadow ${
        selected ? 'border-blue-500 ring-2 ring-blue-500' : tone
      } ${selected ? 'bg-white dark:bg-gray-950' : ''}`}
    >
      <FixedRail />
      {issueCount > 0 ? (
        <span
          aria-label={`${issueCount} problem${issueCount === 1 ? '' : 's'}`}
          className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
        >
          {issueCount}
        </span>
      ) : null}
      <span className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold dark:bg-gray-800">
          {ordinal}
        </span>
        <span aria-hidden="true">⏹</span>
        <span className="min-w-0 truncate text-sm font-medium">{terminal.name || 'End here'}</span>
      </span>
      <span className="mt-1 block text-xs text-gray-600 dark:text-gray-400">
        {RESULT_WORDING[terminal.result]}
      </span>
      {/*
        Unconditional now, where it used to appear only when a notify flag
        was set: an ending always has something worth saying about it, and
        "no model runs here" is that thing. An ending does call tools —
        the email, the WebEx note — but it calls them directly, with no
        model deciding anything.
      */}
      <span className="mt-1.5 flex flex-wrap items-center gap-1">
        <FixedPill />
        {terminal.notifyEmail ? (
          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            ✉ emails you
          </span>
        ) : null}
        {terminal.notifyWebex ? (
          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            WebEx note
          </span>
        ) : null}
      </span>
    </button>
  );
}
