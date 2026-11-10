/**
 * The Pulls card on a code project's page (pulls-summary.tsx): how many
 * are open, the most recently updated one, and — when the host cannot be
 * read — the host's own reason, shown on the card rather than hiding it
 * ("GitHub is not connected. Connect it on the Connectors page, then try
 * again." is what a person needs to see). Tested in
 * pulls-summary.model.test.ts.
 */

import type { HostPullRequest } from '@/lib/code/repo-host';

export interface Summary {
  openCount: number;
  hasMore: boolean;
  mostRecent: HostPullRequest | null;
}

export interface PullsSummaryState {
  summary: Summary | null;
  error: string | null;
}

export const initialPullsSummary: PullsSummaryState = { summary: null, error: null };

export type PullsSummaryAction =
  { type: 'loaded'; summary: Summary } | { type: 'loadFailed'; error: string | null };

/** What the card says when the read fails without a reason of its own. */
export const FALLBACK_ERROR = 'Pull requests could not be read.';

export function pullsSummaryReducer(
  state: PullsSummaryState,
  action: PullsSummaryAction
): PullsSummaryState {
  switch (action.type) {
    case 'loaded':
      return { summary: action.summary, error: null };
    case 'loadFailed':
      return { ...state, error: action.error ?? FALLBACK_ERROR };
  }
}

/** What the card body shows: the reason, Reading…, the most recent PR, or none open. */
export function summaryView(state: PullsSummaryState): 'error' | 'reading' | 'recent' | 'none' {
  if (state.error) return 'error';
  if (state.summary === null) return 'reading';
  return state.summary.mostRecent ? 'recent' : 'none';
}

/** The count pill: green with some open, gray with none, `+` when the host has more than it sent. */
export function openCountPill(summary: Summary): { tone: 'green' | 'gray'; label: string } {
  return {
    tone: summary.openCount > 0 ? 'green' : 'gray',
    label: `${summary.openCount}${summary.hasMore ? '+' : ''} open`,
  };
}
