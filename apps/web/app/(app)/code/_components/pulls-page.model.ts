/**
 * The Pulls page's state (pulls-page.tsx): the open pull requests as the
 * code host last answered, and what each row shows — its state pill,
 * whether it offers a subscription (only an open one does), its branches.
 * A failed read keeps what was shown and says why, with the host's own
 * words ("GitHub is not connected. …"). Tested in pulls-page.model.test.ts.
 */

import type { HostPullRequest } from '@/lib/code/repo-host';

export interface PullsState {
  /** null until the first read answers. */
  pullRequests: HostPullRequest[] | null;
  loadError: string | null;
  busy: boolean;
}

export const initialPulls: PullsState = { pullRequests: null, loadError: null, busy: false };

export type PullsAction =
  | { type: 'reading' }
  | { type: 'loaded'; pullRequests: HostPullRequest[] }
  | { type: 'loadFailed'; error: string };

export function pullsReducer(state: PullsState, action: PullsAction): PullsState {
  switch (action.type) {
    case 'reading':
      return { ...state, busy: true };
    case 'loaded':
      return { ...state, busy: false, pullRequests: action.pullRequests, loadError: null };
    case 'loadFailed':
      return { ...state, busy: false, loadError: action.error };
  }
}

/** What the page shows: the reason a read failed, Reading…, none open, or the list. */
export function pullsView(state: PullsState): 'error' | 'reading' | 'empty' | 'list' {
  if (state.loadError) return 'error';
  if (state.pullRequests === null) return 'reading';
  return state.pullRequests.length === 0 ? 'empty' : 'list';
}

export type PillTone = 'green' | 'purple' | 'gray';

/** A pull request's state as its pill reads: Merged, Closed (declined too), or Open. */
export function pullStatePill(state: HostPullRequest['state']): { tone: PillTone; label: string } {
  if (state === 'merged') return { tone: 'purple', label: 'Merged' };
  if (state === 'declined' || state === 'closed') return { tone: 'gray', label: 'Closed' };
  return { tone: 'green', label: 'Open' };
}

/** Only an open pull request can be subscribed to: a merged or closed one has no pipeline to come. */
export function offersSubscribe(pr: Pick<HostPullRequest, 'state'>): boolean {
  return pr.state === 'open';
}

/** A pull request's link text: its number and title. */
export function pullTitle(pr: Pick<HostPullRequest, 'number' | 'title'>): string {
  return `#${pr.number} ${pr.title}`;
}

/** Where it merges from and to. */
export function pullBranches(
  pr: Pick<HostPullRequest, 'sourceBranch' | 'destinationBranch'>
): string {
  return `${pr.sourceBranch} → ${pr.destinationBranch}`;
}
