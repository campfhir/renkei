/**
 * The Code page's list (code-index.model.ts): what a search finds, how
 * the list pages, and where its links go.
 */

import type { ProjectListItem } from '@/lib/chat/sidebar';
import {
  codeIndexHref,
  codeIndexQuery,
  codeIndexView,
  matchingProjects,
  ownerLabel,
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
const ids = (items: ProjectListItem[]) => items.map((p) => p.id);

describe('searching', () => {
  const list = [
    project(1, { name: 'Ledger', description: 'Double-entry bookkeeping service' }),
    project(2, { name: 'Site', repoFullName: 'acme/marketing-site' }),
    project(3, { name: 'Tools', ownerName: 'Ada Lovelace', role: 'member' }),
  ];

  it('finds a project by its description, repository or owner, ignoring case', () => {
    expect(ids(matchingProjects(list, 'BOOKKEEPING'))).toEqual(['p1']);
    expect(ids(matchingProjects(list, 'marketing'))).toEqual(['p2']);
    expect(ids(matchingProjects(list, 'lovelace'))).toEqual(['p3']);
  });

  it('needs every word, in any order and any field', () => {
    expect(ids(matchingProjects(list, 'service ledger'))).toEqual(['p1']);
    expect(matchingProjects(list, 'ledger marketing')).toEqual([]);
  });

  it('shows everything for a blank search', () => {
    expect(matchingProjects(list, '   ')).toHaveLength(3);
  });

  it('tells "none yet" from "nothing matches"', () => {
    expect(codeIndexView([], codeIndexQuery({ q: 'x' })).empty).toBe('none');
    expect(codeIndexView(list, codeIndexQuery({ q: 'zzz' })).empty).toBe('no-match');
    expect(codeIndexView(list, codeIndexQuery({})).empty).toBeNull();
  });
});

describe('the list', () => {
  it('puts mine first, then the ones shared with me', () => {
    const list = [
      project(1, { role: 'member', ownerName: 'Ada' }),
      project(2),
      project(3, { role: 'member', ownerName: 'Bo' }),
      project(4),
    ];
    expect(ids(codeIndexView(list, codeIndexQuery({})).paging.rows)).toEqual([
      'p2',
      'p4',
      'p1',
      'p3',
    ]);
  });

  it('pages ten at a time, with the range', () => {
    const first = codeIndexView(many(25), codeIndexQuery({})).paging;
    expect(first.rows).toHaveLength(10);
    expect(first.range).toBe('1–10 of 25');
    const last = codeIndexView(many(25), codeIndexQuery({ page: '3' })).paging;
    expect(ids(last.rows)).toEqual(['p21', 'p22', 'p23', 'p24', 'p25']);
    expect(last.range).toBe('21–25 of 25');
    expect(last.hasNext).toBe(false);
  });

  it('a page past the end shows the last, and a bad page the first', () => {
    expect(codeIndexView(many(25), codeIndexQuery({ page: '9' })).paging.page).toBe(3);
    expect(codeIndexView(many(25), codeIndexQuery({ page: 'x' })).paging.page).toBe(1);
  });

  it('pages the matches, not everything', () => {
    const view = codeIndexView(many(25), codeIndexQuery({ q: 'project 2' }));
    expect(view.paging.range).toBe('1–8 of 8');
  });

  it('says who owns each: "You", or the name', () => {
    expect(ownerLabel(project(1))).toBe('You');
    expect(ownerLabel(project(2, { role: 'member', ownerName: 'Ada' }))).toBe('Ada');
    expect(ownerLabel(project(3, { role: 'member' }))).toBe('Someone');
  });
});

describe('links', () => {
  it('leave out page 1 and an empty search, and keep the search across pages', () => {
    expect(codeIndexHref({ q: '', page: 1 })).toBe('/code');
    expect(codeIndexHref({ q: '', page: 3 })).toBe('/code?page=3');
    expect(codeIndexHref({ q: 'billing api', page: 2 })).toBe('/code?q=billing+api&page=2');
  });

  it('read the search trimmed and bounded', () => {
    expect(codeIndexQuery({ q: '  ledger ' })).toEqual({ q: 'ledger', page: 1 });
    expect(codeIndexQuery({ q: 'x'.repeat(500) }).q).toHaveLength(200);
  });
});
