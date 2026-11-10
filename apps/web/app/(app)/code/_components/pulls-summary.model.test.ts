/**
 * The Pulls card on the project page (pulls-summary.model.ts). The browser
 * spec (project-pulls-commits.spec.ts) keeps the card rendering on the real
 * server, and the not-connected reason reaching it.
 */

import type { HostPullRequest } from '@/lib/code/repo-host';
import {
  FALLBACK_ERROR,
  initialPullsSummary,
  openCountPill,
  pullsSummaryReducer,
  summaryView,
} from './pulls-summary.model';

const PR: HostPullRequest = {
  number: 42,
  title: 'Fix the timeout',
  state: 'open',
  draft: false,
  sourceBranch: 'feat/timeout-fix',
  destinationBranch: 'main',
  author: 'octocat',
  updatedAt: '2026-09-01T00:00:00.000Z',
  url: 'https://github.com/acme/site/pull/42',
};

describe('the Pulls card', () => {
  it('says Reading… until the host answers', () => {
    expect(summaryView(initialPullsSummary)).toBe('reading');
  });

  it('shows the most recent pull request, or that none are open', () => {
    const some = pullsSummaryReducer(initialPullsSummary, {
      type: 'loaded',
      summary: { openCount: 2, hasMore: false, mostRecent: PR },
    });
    expect(summaryView(some)).toBe('recent');
    const none = pullsSummaryReducer(initialPullsSummary, {
      type: 'loaded',
      summary: { openCount: 0, hasMore: false, mostRecent: null },
    });
    expect(summaryView(none)).toBe('none');
  });

  it('stays on the page with the host’s own reason when it cannot be read', () => {
    const failed = pullsSummaryReducer(initialPullsSummary, {
      type: 'loadFailed',
      error: 'GitHub is not connected. Connect it on the Connectors page, then try again.',
    });
    expect(summaryView(failed)).toBe('error');
    expect(failed.error).toMatch(/^GitHub is not connected/);
    expect(
      pullsSummaryReducer(initialPullsSummary, { type: 'loadFailed', error: null }).error
    ).toBe(FALLBACK_ERROR);
  });

  it('counts the open ones, with a + when the host has more than it sent', () => {
    expect(openCountPill({ openCount: 2, hasMore: false, mostRecent: PR })).toEqual({
      tone: 'green',
      label: '2 open',
    });
    expect(openCountPill({ openCount: 25, hasMore: true, mostRecent: PR }).label).toBe('25+ open');
    expect(openCountPill({ openCount: 0, hasMore: false, mostRecent: null })).toEqual({
      tone: 'gray',
      label: '0 open',
    });
  });
});
