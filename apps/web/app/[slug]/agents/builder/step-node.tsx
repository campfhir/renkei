'use client';

/**
 * One node in the flow chart — a step collapsed to its name, a one-line
 * preview, and badges for anything invisible that changes behavior (retry,
 * stop-on-success, saved result). Clicking it opens the editor panel; the
 * card itself edits nothing.
 */

import { useMemo } from 'react';
import { instructionPreview, type AgentStep } from '@renkei/agents';

export function StepNode({
  step,
  ordinal,
  selected,
  issueCount,
  onSelect,
}: {
  step: AgentStep;
  ordinal: number;
  selected: boolean;
  issueCount: number;
  onSelect: () => void;
}) {
  const preview = useMemo(() => {
    const text = instructionPreview(step.instruction).trim();
    return text.length > 70 ? `${text.slice(0, 70)}…` : text;
  }, [step.instruction]);

  const hasRetry = step.failureHandling.some((entry) => entry.action === 'retry');

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Edit step ${ordinal}: ${step.name || 'unnamed'}`}
      className={`relative w-64 rounded-lg border bg-white p-3 text-left shadow-sm transition-shadow hover:shadow dark:bg-gray-950 ${
        selected ? 'border-blue-500 ring-2 ring-blue-500' : 'border-gray-200 dark:border-gray-800'
      }`}
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
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold dark:bg-gray-800">
          {ordinal}
        </span>
        <span className="min-w-0 truncate text-sm font-medium">
          {step.name || `Step ${ordinal}`}
        </span>
      </span>
      {preview ? (
        <span className="mt-1 block truncate text-xs text-gray-500 dark:text-gray-400">
          {preview}
        </span>
      ) : (
        <span className="mt-1 block text-xs italic text-gray-400">Empty step</span>
      )}
      {hasRetry ||
      step.onSuccess === 'stop' ||
      step.onSuccess === 'stop-quiet' ||
      step.saveAs ||
      step.tool === null ? (
        <span className="mt-1.5 flex flex-wrap items-center gap-1">
          {step.tool === null ? (
            <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-400">
              thinks
            </span>
          ) : null}
          {hasRetry ? (
            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
              ↻ up to {step.maxAttempts}×
            </span>
          ) : null}
          {step.onSuccess === 'stop' || step.onSuccess === 'stop-quiet' ? (
            <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
              {step.onSuccess === 'stop' ? 'stops here' : 'stops silently'}
            </span>
          ) : null}
          {step.saveAs ? (
            <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
              saves “{step.saveAs}”
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}
