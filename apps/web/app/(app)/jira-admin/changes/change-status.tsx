/**
 * Human wording and color for a Jira admin change request's state — the
 * stored status plus the two read from the clock (expired, interrupted;
 * lib/jira-admin/change-requests.ts). The batch-jobs pill's shape.
 */

import type { ChangeRequestState } from '@/lib/jira-admin/change-requests';

const LABELS: Record<ChangeRequestState, string> = {
  pending: 'Waiting for review',
  applying: 'Applying',
  applied: 'Applied',
  // Some operations reached Jira before one failed — not the green of a
  // clean apply, nor the red of nothing done.
  partial: 'Partly applied',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  interrupted: 'Interrupted',
};

function tone(state: ChangeRequestState): string {
  switch (state) {
    case 'applied':
      return 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300';
    case 'partial':
    case 'interrupted':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
    case 'pending':
    case 'applying':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
    default:
      // cancelled, expired
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

export function changeStateLabel(state: ChangeRequestState): string {
  return LABELS[state];
}

export function ChangeStatePill({ state }: { state: ChangeRequestState }) {
  return (
    <span
      data-testid="change-state"
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone(state)}`}
    >
      {LABELS[state]}
    </span>
  );
}
