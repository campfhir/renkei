/**
 * The Pulls page's behaviour (pulls-page.model.ts). The browser spec
 * (project-pulls-commits.spec.ts) keeps the page rendering the rows, in
 * whichever layout fits the width.
 */

import type { HostPullRequest } from '@/lib/code/repo-host';
import {
  initialPulls,
  offersSubscribe,
  pullBranches,
  pullStatePill,
  pullTitle,
  pullsReducer,
  pullsView,
  type PullsAction,
  type PullsState,
} from './pulls-page.model';

const pr = (number: number, more: Partial<HostPullRequest> = {}): HostPullRequest => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  sourceBranch: 'feat/x',
  destinationBranch: 'main',
  author: 'octocat',
  updatedAt: '2026-09-01T00:00:00.000Z',
  url: `https://github.com/acme/site/pull/${number}`,
  ...more,
});

const run = (actions: PullsAction[], from: PullsState = initialPulls) =>
  actions.reduce(pullsReducer, from);

describe('the list', () => {
  it('says Reading… until the host answers, then lists or says none are open', () => {
    expect(pullsView(initialPulls)).toBe('reading');
    expect(pullsView(run([{ type: 'loaded', pullRequests: [] }]))).toBe('empty');
    expect(pullsView(run([{ type: 'loaded', pullRequests: [pr(42), pr(41)] }]))).toBe('list');
  });

  it('Refresh is busy while it reads, and a failure shows the host’s reason', () => {
    const reading = run([{ type: 'reading' }]);
    expect(reading.busy).toBe(true);
    const failed = run([{ type: 'loadFailed', error: 'GitHub is not connected.' }], reading);
    expect(pullsView(failed)).toBe('error');
    expect(failed).toMatchObject({ busy: false, loadError: 'GitHub is not connected.' });
    expect(pullsView(run([{ type: 'loaded', pullRequests: [pr(1)] }], failed))).toBe('list');
  });
});

describe('a row', () => {
  it('reads as its number and title, from its branch into the target', () => {
    expect(pullTitle(pr(41, { title: 'Earlier fix' }))).toBe('#41 Earlier fix');
    expect(pullBranches(pr(42, { sourceBranch: 'feat/timeout-fix' }))).toBe(
      'feat/timeout-fix → main'
    );
  });

  it('pills its state: Open, Merged, and Closed for declined or closed', () => {
    expect(pullStatePill('open')).toEqual({ tone: 'green', label: 'Open' });
    expect(pullStatePill('merged')).toEqual({ tone: 'purple', label: 'Merged' });
    expect(pullStatePill('declined')).toEqual({ tone: 'gray', label: 'Closed' });
    expect(pullStatePill('closed')).toEqual({ tone: 'gray', label: 'Closed' });
  });

  it('offers a subscription only on an open one', () => {
    expect(offersSubscribe({ state: 'open' })).toBe(true);
    expect(offersSubscribe({ state: 'merged' })).toBe(false);
    expect(offersSubscribe({ state: 'declined' })).toBe(false);
  });
});
