/**
 * The Commits page's state (commits-page.tsx): the history as last read,
 * how much of it is asked for, and whether more is there.
 *
 * "Load more" widens the page rather than following a cursor (the host
 * adapter has no next-page token): each press asks for PAGE more, from
 * the newest, and the answer's `hasMore` decides whether the button
 * stays. A failed read keeps what was shown and says why. Tested in
 * commits-page.model.test.ts.
 */

import type { HostCommit } from '@/lib/code/repo-host';

/** How many commits one press of "Load more" adds. */
export const PAGE = 30;

export interface CommitsState {
  /** null until the first read answers. */
  commits: HostCommit[] | null;
  hasMore: boolean;
  /** How many the page asks for. */
  max: number;
  loadError: string | null;
  busy: boolean;
}

export const initialCommits: CommitsState = {
  commits: null,
  hasMore: false,
  max: PAGE,
  loadError: null,
  busy: false,
};

export type CommitsAction =
  | { type: 'reading' }
  | { type: 'loaded'; commits: HostCommit[]; hasMore: boolean }
  | { type: 'loadFailed'; error: string }
  | { type: 'loadMore' };

export function commitsReducer(state: CommitsState, action: CommitsAction): CommitsState {
  switch (action.type) {
    case 'reading':
      return { ...state, busy: true };
    case 'loaded':
      return {
        ...state,
        busy: false,
        commits: action.commits,
        hasMore: action.hasMore,
        loadError: null,
      };
    case 'loadFailed':
      return { ...state, busy: false, loadError: action.error };
    case 'loadMore':
      return { ...state, max: state.max + PAGE };
  }
}

/** The read the page makes for how much it asks for. */
export function commitsUrl(projectId: string, max: number): string {
  return `/api/code/projects/${projectId}/commits?max=${max}`;
}

/** What the page shows: the reason a read failed, Reading…, an empty history, or the list. */
export function commitsView(state: CommitsState): 'error' | 'reading' | 'empty' | 'list' {
  if (state.loadError) return 'error';
  if (state.commits === null) return 'reading';
  return state.commits.length === 0 ? 'empty' : 'list';
}

/** A commit's short hash, as the list links it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** The "Load more" button: shown while the host says there is more, and its words while it reads. */
export function loadMoreButton(state: CommitsState): { label: string; disabled: boolean } | null {
  if (!state.hasMore) return null;
  return { label: state.busy ? 'Loading…' : 'Load more', disabled: state.busy };
}
