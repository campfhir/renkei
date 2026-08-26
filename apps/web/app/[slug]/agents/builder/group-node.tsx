'use client';

/**
 * The group node card — the slate header of a group container. Groups are
 * pure structure (no run behavior), so the card is deliberately quiet.
 */

import type { GroupStep } from '@renkei/agents';
import { FixedMark } from './fixed-marker';

export function GroupNode({
  group,
  ordinal,
  selected,
  issueCount,
  onSelect,
}: {
  group: GroupStep;
  ordinal: number;
  selected: boolean;
  issueCount: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Edit group: ${group.name || 'unnamed'}`}
      className={`relative w-64 rounded-lg border p-3 text-left shadow-sm transition-shadow hover:shadow ${
        selected ? 'border-blue-500 ring-2 ring-blue-500' : 'border-slate-300 dark:border-slate-700'
      } bg-slate-50 dark:bg-slate-900/60`}
    >
      {issueCount > 0 ? (
        <span
          aria-label={`${issueCount} problem${issueCount === 1 ? '' : 's'}`}
          className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
        >
          {issueCount}
        </span>
      ) : null}
      <span className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          {ordinal}
        </span>
        <span aria-hidden="true" className="text-slate-500 dark:text-slate-400">
          ▣
        </span>
        <span className="min-w-0 truncate text-sm font-medium">
          {group.name || 'Unnamed group'}
        </span>
        <FixedMark />
      </span>
      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
        {group.steps.length === 0
          ? 'Empty group'
          : `${group.steps.length} step${group.steps.length === 1 ? '' : 's'} inside`}
      </span>
    </button>
  );
}
