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
    expect(codeIndexView([], codeIndexQuery({ q: 'x' })).mine.empty).toBe('none');
    expect(codeIndexView(list, codeIndexQuery({ q: 'zzz' })).mine.empty).toBe('no-match');
    expect(codeIndexView(list, codeIndexQuery({})).mine.empty).toBeNull();
  });
});

describe('the two tables', () => {
  const list = [
    project(1, { role: 'member', ownerName: 'Ada' }),
    project(2),
    project(3, { role: 'member', ownerName: 'Bo' }),
    project(4),
  ];

  it('keeps mine and the shared ones apart, each in the order loaded', () => {
    const view = codeIndexView(list, codeIndexQuery({}));
    expect(ids(view.mine.paging.rows)).toEqual(['p2', 'p4']);
    expect(ids(view.shared.paging.rows)).toEqual(['p1', 'p3']);
  });

  it('searches both, and says which one found nothing', () => {
    const view = codeIndexView(list, codeIndexQuery({ q: 'ada' }));
    expect(view.mine.empty).toBe('no-match');
    expect(ids(view.shared.paging.rows)).toEqual(['p1']);
    expect(codeIndexView(list.filter((p) => p.role === 'owner'), codeIndexQuery({})).shared.empty).toBe(
      'none'
    );
  });

  it('pages each table ten at a time, on its own', () => {
    const shared = many(25).map((p) => ({ ...p, id: `s${p.id}`, role: 'member' as const }));
    const all = [...many(12), ...shared];
    const view = codeIndexView(all, codeIndexQuery({ page: '2', shared: '3' }));
    expect(ids(view.mine.paging.rows)).toEqual(['p11', 'p12']);
    expect(view.mine.paging.range).toBe('11–12 of 12');
    expect(view.shared.paging.rows).toHaveLength(5);
    expect(view.shared.paging.range).toBe('21–25 of 25');
  });

  it('a page past the end shows the last, and a bad page the first', () => {
    expect(codeIndexView(many(25), codeIndexQuery({ page: '9' })).mine.paging.page).toBe(3);
    expect(codeIndexView(many(25), codeIndexQuery({ page: 'x' })).mine.paging.page).toBe(1);
  });

  it('names the owner of a shared project', () => {
    expect(ownerLabel(project(2, { role: 'member', ownerName: 'Ada' }))).toBe('Ada');
    expect(ownerLabel(project(3, { role: 'member' }))).toBe('Someone');
  });
});

describe('links', () => {
  it('leave out page 1 and an empty search, and keep the other table’s place', () => {
    expect(codeIndexHref({ q: '', page: 1, sharedPage: 1 })).toBe('/code');
    expect(codeIndexHref({ q: '', page: 3, sharedPage: 1 })).toBe('/code?page=3');
    expect(codeIndexHref({ q: 'billing api', page: 2, sharedPage: 4 })).toBe(
      '/code?q=billing+api&page=2&shared=4'
    );
  });

  it('read the search trimmed and bounded', () => {
    expect(codeIndexQuery({ q: '  ledger ' })).toEqual({ q: 'ledger', page: 1, sharedPage: 1 });
    expect(codeIndexQuery({ q: 'x'.repeat(500) }).q).toHaveLength(200);
  });
});
