/**
 * The Commits page's behaviour (commits-page.model.ts). The browser spec
 * (project-pulls-commits.spec.ts) keeps one Load more pressed through to
 * the route and drawn; how far it asks and when the button goes is here.
 */

import type { HostCommit } from '@/lib/code/repo-host';
import {
  commitsReducer,
  commitsUrl,
  commitsView,
  initialCommits,
  loadMoreButton,
  PAGE,
  shortSha,
  type CommitsAction,
  type CommitsState,
} from './commits-page.model';

const commit = (sha: string): HostCommit => ({
  sha,
  message: `Commit ${sha}`,
  author: 'octocat',
  date: '2026-09-01T00:00:00.000Z',
  url: `https://github.com/acme/site/commit/${sha}`,
});

const run = (actions: CommitsAction[], from: CommitsState = initialCommits) =>
  actions.reduce(commitsReducer, from);

describe('the history', () => {
  it('says Reading… until the host answers, then lists or says there are none', () => {
    expect(commitsView(initialCommits)).toBe('reading');
    expect(commitsView(run([{ type: 'loaded', commits: [], hasMore: false }]))).toBe('empty');
    expect(commitsView(run([{ type: 'loaded', commits: [commit('a')], hasMore: false }]))).toBe(
      'list'
    );
  });

  it('a failed read shows the host’s reason, and the next good read clears it', () => {
    const failed = run([
      { type: 'reading' },
      { type: 'loadFailed', error: 'GitHub is not connected.' },
    ]);
    expect(commitsView(failed)).toBe('error');
    expect(failed.loadError).toBe('GitHub is not connected.');
    expect(failed.busy).toBe(false);
    expect(commitsView(run([{ type: 'loaded', commits: [], hasMore: false }], failed))).toBe(
      'empty'
    );
  });

  it('links each commit by its first twelve characters', () => {
    expect(shortSha('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('aaaaaaaaaaaa');
  });
});

describe('Load more', () => {
  it('first asks for one page', () => {
    expect(initialCommits.max).toBe(PAGE);
    expect(commitsUrl('p1', initialCommits.max)).toBe('/api/code/projects/p1/commits?max=30');
  });

  it('is offered while the host says there is more, and each press asks for a page more', () => {
    const first = run([{ type: 'loaded', commits: [commit('a')], hasMore: true }]);
    expect(loadMoreButton(first)).toEqual({ label: 'Load more', disabled: false });
    const pressed = run([{ type: 'loadMore' }], first);
    expect(pressed.max).toBe(60);
    expect(commitsUrl('p1', pressed.max)).toBe('/api/code/projects/p1/commits?max=60');
    expect(run([{ type: 'loadMore' }], pressed).max).toBe(90);
  });

  it('says Loading… and cannot be pressed while it reads', () => {
    const reading = run([
      { type: 'loaded', commits: [commit('a')], hasMore: true },
      { type: 'loadMore' },
      { type: 'reading' },
    ]);
    expect(loadMoreButton(reading)).toEqual({ label: 'Loading…', disabled: true });
  });

  it('goes once the host says there is nothing more', () => {
    const done = run([
      { type: 'loaded', commits: [commit('a')], hasMore: true },
      { type: 'loadMore' },
      { type: 'loaded', commits: [commit('a'), commit('b')], hasMore: false },
    ]);
    expect(loadMoreButton(done)).toBeNull();
    expect(done.commits?.map((c) => c.sha)).toEqual(['a', 'b']);
  });

  it('a failed read keeps what was shown behind the reason', () => {
    const failed = run([
      { type: 'loaded', commits: [commit('a')], hasMore: true },
      { type: 'loadMore' },
      { type: 'loadFailed', error: 'Rate limited' },
    ]);
    expect(failed.commits?.map((c) => c.sha)).toEqual(['a']);
    expect(failed.loadError).toBe('Rate limited');
  });
});
