/**
 * The Code page's list (code-index.model.ts): searching and paging.
 */

import type { ProjectListItem } from '@/lib/chat/sidebar';
import {
  PAGE_SIZE,
  codeIndexReducer,
  emptyKind,
  initialCodeIndex,
  matchingProjects,
  projectsPage,
  type CodeIndexAction,
} from './code-index.model';

const project = (i: number, more: Partial<ProjectListItem> = {}): ProjectListItem => ({
  id: `p${i}`,
  name: `Project ${i}`,
  ownerSubject: 'me',
  ownerName: null,
  role: 'owner',
  updatedAt: '2026-10-01T00:00:00.000Z',
  repoFullName: `acme/repo-${i}`,
  description: null,
  ...more,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => project(i + 1));
const run = (actions: CodeIndexAction[]) => actions.reduce(codeIndexReducer, initialCodeIndex);

describe('searching', () => {
  const list = [
    project(1, { name: 'Ledger', description: 'Double-entry bookkeeping service' }),
    project(2, { name: 'Site', repoFullName: 'acme/marketing-site' }),
    project(3, { name: 'Tools', ownerName: 'Ada Lovelace', role: 'member' }),
  ];

  it('finds a project by its description, repository or owner, ignoring case', () => {
    expect(matchingProjects(list, 'BOOKKEEPING').map((p) => p.id)).toEqual(['p1']);
    expect(matchingProjects(list, 'marketing').map((p) => p.id)).toEqual(['p2']);
    expect(matchingProjects(list, 'lovelace').map((p) => p.id)).toEqual(['p3']);
  });

  it('needs every word, in any order and any field', () => {
    expect(matchingProjects(list, 'service ledger').map((p) => p.id)).toEqual(['p1']);
    expect(matchingProjects(list, 'ledger marketing')).toEqual([]);
  });

  it('shows everything for a blank search', () => {
    expect(matchingProjects(list, '   ')).toHaveLength(3);
  });

  it('tells "none yet" from "nothing matches"', () => {
    expect(emptyKind([], 'x')).toBe('none');
    expect(emptyKind(list, '')).toBe('none');
    expect(emptyKind(list, 'zzz')).toBe('no-match');
  });
});

describe('paging', () => {
  it('shows PAGE_SIZE at a time, with the range and the page count', () => {
    const first = projectsPage(many(25), initialCodeIndex, 'mine');
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(first.range).toEqual([1, 10]);
    expect(first.pageCount).toBe(3);
    const last = projectsPage(many(25), run([{ type: 'page', group: 'mine', page: 2 }]), 'mine');
    expect(last.items.map((p) => p.id)).toEqual(['p21', 'p22', 'p23', 'p24', 'p25']);
    expect(last.range).toEqual([21, 25]);
  });

  it('pages each group on its own', () => {
    const state = run([{ type: 'page', group: 'mine', page: 1 }]);
    expect(projectsPage(many(25), state, 'mine').page).toBe(1);
    expect(projectsPage(many(25), state, 'shared').page).toBe(0);
  });

  it('a new search goes back to the first page of both groups', () => {
    const state = run([
      { type: 'page', group: 'mine', page: 2 },
      { type: 'page', group: 'shared', page: 1 },
      { type: 'query', value: 'project' },
    ]);
    expect(state.pages).toEqual({ mine: 0, shared: 0 });
  });

  it('a page past the end of a narrowed list falls back to the last one', () => {
    const state = run([{ type: 'page', group: 'mine', page: 2 }, { type: 'query', value: 'x' }]);
    const narrowed = run([
      { type: 'query', value: 'project 1' },
      { type: 'page', group: 'mine', page: 5 },
    ]);
    expect(state.pages.mine).toBe(0);
    const shown = projectsPage(many(25), narrowed, 'mine');
    expect(shown.page).toBe(shown.pageCount - 1);
    expect(shown.items.length).toBeGreaterThan(0);
  });

  it('has one empty page and no range when nothing matches', () => {
    const none = projectsPage(many(5), run([{ type: 'query', value: 'zzz' }]), 'mine');
    expect(none).toMatchObject({ total: 0, pageCount: 1, range: null, items: [] });
  });
});
