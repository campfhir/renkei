/**
 * The badge on a project's chat row (chat-pr-badge.model.ts). The browser
 * spec (project-pulls-commits.spec.ts) keeps the badge drawn on the row.
 */

import { badgeOf, chatPullRequestOf } from './chat-pr-badge.model';

describe('a chat row’s pull request badge', () => {
  it('shows the chat’s most recent pull request by number', () => {
    const pr = chatPullRequestOf({
      pullRequest: { number: 42, title: 'Fix the timeout', state: 'open', host: 'github' },
    });
    expect(pr).toEqual({ number: 42, state: 'open' });
    expect(badgeOf(pr!)).toEqual({
      text: '#42',
      tone: 'green',
      title: 'Pull request #42 — open',
    });
  });

  it('is purple once merged', () => {
    expect(badgeOf({ number: 7, state: 'merged' })).toMatchObject({ tone: 'purple', text: '#7' });
  });

  it('shows nothing for a chat that never touched one, or an answer that is not one', () => {
    expect(chatPullRequestOf({ pullRequest: null })).toBeNull();
    expect(chatPullRequestOf(null)).toBeNull();
    expect(chatPullRequestOf({ pullRequest: { number: '42', state: 'open' } })).toBeNull();
    expect(chatPullRequestOf({ pullRequest: { number: 0, state: 'open' } })).toBeNull();
    expect(chatPullRequestOf({ pullRequest: { number: 3, state: 'closed' } })).toBeNull();
  });
});
