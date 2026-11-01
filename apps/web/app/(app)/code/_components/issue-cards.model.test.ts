/**
 * The issue cards beside the active chat (issue-cards.model.ts). The
 * browser spec (issue-cards.spec.ts) keeps both cards drawn on the project
 * page and at phone width; the "say nothing" cases are here, and the real
 * route's empty answer is its route test.
 */

import { cardLine, issueCardsOf } from './issue-cards.model';

const JIRA = {
  key: 'PROJ-9',
  title: 'Retry loop spins forever',
  status: 'In Progress',
  url: 'https://acme.atlassian.net/browse/PROJ-9',
};
const GITHUB = {
  number: 41,
  title: 'Retry loop bug',
  state: 'open',
  url: 'https://github.com/acme/site/issues/41',
};

describe('issue cards', () => {
  it('shows a Jira card and a GitHub issue card on a match, Jira first', () => {
    expect(issueCardsOf({ jira: JIRA, github: GITHUB })).toEqual([
      { label: 'PROJ-9', title: 'Retry loop spins forever', sub: 'In Progress', url: JIRA.url },
      { label: '#41', title: 'Retry loop bug', sub: 'open', url: GITHUB.url },
    ]);
  });

  it('shows just the one that resolved', () => {
    expect(issueCardsOf({ jira: null, github: GITHUB }).map((card) => card.label)).toEqual(['#41']);
    expect(issueCardsOf({ jira: JIRA, github: null }).map((card) => card.label)).toEqual([
      'PROJ-9',
    ]);
  });

  it('shows nothing when the lookup finds neither, and nothing on a failed or odd answer', () => {
    expect(issueCardsOf({ jira: null, github: null })).toEqual([]);
    expect(issueCardsOf({})).toEqual([]);
    expect(issueCardsOf(null)).toEqual([]);
    expect(issueCardsOf({ jira: { key: 'PROJ-9' }, github: { number: '41' } })).toEqual([]);
  });

  it('reads a card as its key and title, or the key alone', () => {
    expect(cardLine({ label: 'PROJ-9', title: 'Retry loop', sub: '', url: '' })).toBe(
      'PROJ-9 · Retry loop'
    );
    expect(cardLine({ label: '#41', title: '', sub: '', url: '' })).toBe('#41 ');
  });
});
