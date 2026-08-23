'use client';

/**
 * The loop node card — the amber header of a loop container. Like every
 * canvas card it only selects; editing happens in the panel. The container
 * chrome (border, back-edge, collapse) is drawn by the canvas around it.
 */

import { useMemo } from 'react';
import { instructionPreview, type LoopStep } from '@renkei/agents';

export function LoopNode({
  loop,
  ordinal,
  selected,
  issueCount,
  onSelect,
}: {
  loop: LoopStep;
  ordinal: number;
  selected: boolean;
  issueCount: number;
  onSelect: () => void;
}) {
  const summary = useMemo(() => {
    if (loop.mode === 'foreach') {
      return loop.itemsVar ? `For each ${loop.itemVar} in “${loop.itemsVar}”` : 'For each item…';
    }
    const text = instructionPreview(loop.condition).trim();
    return text ? `Until: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : 'Repeats until…';
  }, [loop]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Edit loop: ${loop.name || 'unnamed'}`}
      className={`relative w-64 rounded-lg border p-3 text-left shadow-sm transition-shadow hover:shadow ${
        selected ? 'border-blue-500 ring-2 ring-blue-500' : 'border-amber-300 dark:border-amber-800'
      } bg-amber-50/60 dark:bg-amber-950/40`}
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
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[11px] font-semibold text-amber-700 dark:bg-amber-900 dark:text-amber-300">
          {ordinal}
        </span>
        <span aria-hidden="true" className="text-amber-600 dark:text-amber-400">
          ↻
        </span>
        <span className="min-w-0 truncate text-sm font-medium">{loop.name || 'Unnamed loop'}</span>
      </span>
      <span className="mt-1 block truncate text-xs text-gray-600 dark:text-gray-400">
        {summary}
      </span>
      <span className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">
          up to {loop.maxIterations}×
        </span>
        {loop.collectVar ? (
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            collects “{loop.collectVar}”
          </span>
        ) : null}
      </span>
    </button>
  );
}
