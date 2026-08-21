'use client';

/**
 * The branch node card — visually distinct from action steps (indigo, fork
 * glyph) because it decides rather than does. The fan-out to its two path
 * columns is drawn by the canvas; this is just the decision card.
 */

import { useMemo } from 'react';
import { instructionPreview, type BranchStep } from '@renkei/agents';

export function BranchNode({
  branch,
  ordinal,
  selected,
  issueCount,
  onSelect,
}: {
  branch: BranchStep;
  /**
   * Pre-order step number, shown so the sequence has no visible gaps: a
   * branch consumes an ordinal like any node, and review notes ("Step 6")
   * must be findable on the canvas.
   */
  ordinal: number;
  selected: boolean;
  issueCount: number;
  onSelect: () => void;
}) {
  const preview = useMemo(() => {
    const text = instructionPreview(branch.condition).trim();
    return text.length > 70 ? `${text.slice(0, 70)}…` : text;
  }, [branch.condition]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Edit branch: ${branch.name || 'unnamed'}`}
      className={`relative w-64 rounded-lg border p-3 text-left shadow-sm transition-shadow hover:shadow ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-500'
          : 'border-indigo-300 dark:border-indigo-800'
      } bg-indigo-50/60 dark:bg-indigo-950/40`}
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
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
          {ordinal}
        </span>
        <span aria-hidden="true" className="text-indigo-600 dark:text-indigo-400">
          ⑂
        </span>
        <span className="min-w-0 truncate text-sm font-medium">
          {branch.name || 'Unnamed branch'}
        </span>
      </span>
      {preview ? (
        <span className="mt-1 block truncate text-xs text-gray-600 dark:text-gray-400">
          {preview}
        </span>
      ) : (
        <span className="mt-1 block text-xs italic text-gray-400">No condition yet</span>
      )}
    </button>
  );
}
