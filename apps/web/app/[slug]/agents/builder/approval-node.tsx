'use client';

/**
 * The approval (pause) node card — sky-tinted: the run stops here and
 * waits for the OWNER. Badges say the mode, the wait ceiling, and which
 * notification channels announce the card.
 */

import { useMemo } from 'react';
import { approvalFieldsOf, instructionPreview, type ApprovalStep } from '@renkei/agents';
import { FixedMark } from './fixed-marker';

function waitLabel(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  return `${hours}h`;
}

export function ApprovalNode({
  approval,
  ordinal,
  selected,
  issueCount,
  onSelect,
}: {
  approval: ApprovalStep;
  ordinal: number;
  selected: boolean;
  issueCount: number;
  onSelect: () => void;
}) {
  const preview = useMemo(() => {
    const text = instructionPreview(approval.message).trim();
    return text.length > 70 ? `${text.slice(0, 70)}…` : text;
  }, [approval.message]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Edit approval: ${approval.name || 'unnamed'}`}
      className={`relative w-64 rounded-lg border p-3 text-left shadow-sm transition-shadow hover:shadow ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-500 bg-white dark:bg-gray-950'
          : 'border-sky-300 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40'
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
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[11px] font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-300">
          {ordinal}
        </span>
        <span aria-hidden="true">✋</span>
        <span className="min-w-0 truncate text-sm font-medium">
          {approval.name || 'Ask for approval'}
        </span>
        <FixedMark />
      </span>
      {preview ? (
        <span className="mt-1 block truncate text-xs text-gray-600 dark:text-gray-400">
          {preview}
        </span>
      ) : (
        <span className="mt-1 block text-xs italic text-gray-400">No message yet</span>
      )}
      <span className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900 dark:text-sky-300">
          {approval.mode === 'input'
            ? approvalFieldsOf(approval).length > 0
              ? `asks for ${approvalFieldsOf(approval).length} things`
              : 'asks for an answer'
            : 'approve / decline'}
        </span>
        <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-200">
          waits ≤ {waitLabel(approval.timeoutHours)}
        </span>
        {approval.notifyEmail ? (
          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            ✉ emails you
          </span>
        ) : null}
        {approval.notifyWebex ? (
          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">
            WebEx note
          </span>
        ) : null}
        {approval.saveAs ? (
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            saves “{approval.saveAs}”
          </span>
        ) : null}
      </span>
    </button>
  );
}
