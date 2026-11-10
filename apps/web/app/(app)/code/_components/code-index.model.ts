/**
 * The Code page's project list: one table — mine first, then the ones
 * shared with me — searched with `?q=` and paged ten at a time with
 * `?page=`, both in the URL so a view is linkable (the shape the runs list
 * has). The page loads every project the person can open; this narrows
 * and slices them, and says where the links go. Pure.
 *
 * Each table has a fixed height: five of mine, three shared with me, a
 * short page padded with blank rows (`fillerCount`) so neither table moves.
 */

import type { ProjectListItem } from '@/lib/chat/sidebar';
import { listPage, pageFromParam, type ListPage } from '../../agents/agents-page.model';

export { pageFromParam };

export const MINE_PAGE_SIZE = 5;
export const SHARED_PAGE_SIZE = 3;

export interface CodeIndexQuery {
  /** The search text, trimmed; empty for none. */
  q: string;
  /** 1-based, as asked (the view clamps it): my projects' page … */
  page: number;
  /** … and the shared ones', each table paging on its own. */
  sharedPage: number;
}

/** The query a request's search params spell: text trimmed, a bad page as the first. */
export function codeIndexQuery(params: {
  q?: string;
  page?: string;
  shared?: string;
}): CodeIndexQuery {
  return {
    q: (params.q ?? '').trim().slice(0, 200),
    page: pageFromParam(params.page),
    sharedPage: pageFromParam(params.shared),
  };
}

/** Every word typed must appear somewhere in the project's name, repository, description or owner. */
export function matchingProjects(projects: ProjectListItem[], q: string): ProjectListItem[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return projects;
  return projects.filter((project) => {
    const haystack = [project.name, project.repoFullName, project.description, project.ownerName]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface CodeIndexGroup {
  /** Rows to a page: what the table is padded to. */
  size: number;
  paging: ListPage<ProjectListItem>;
  /** Why the table is empty, when it is: nothing exists yet, or the search found nothing. */
  empty: 'none' | 'no-match' | null;
}

export interface CodeIndexView {
  mine: CodeIndexGroup;
  shared: CodeIndexGroup;
}

function groupOf(
  all: ProjectListItem[],
  q: string,
  page: number,
  size: number
): CodeIndexGroup {
  const matches = matchingProjects(all, q);
  return {
    paging: listPage(matches, page, size),
    size,
    empty: matches.length > 0 ? null : all.length === 0 ? 'none' : 'no-match',
  };
}

/** My projects and the ones shared with me, each searched and paged on its own, in the order loaded. */
export function codeIndexView(projects: ProjectListItem[], query: CodeIndexQuery): CodeIndexView {
  return {
    mine: groupOf(
      projects.filter((project) => project.role === 'owner'),
      query.q,
      query.page,
      MINE_PAGE_SIZE
    ),
    shared: groupOf(
      projects.filter((project) => project.role !== 'owner'),
      query.q,
      query.sharedPage,
      SHARED_PAGE_SIZE
    ),
  };
}

/** A link to the list at this search and these pages (page 1 and an empty search left out of the URL). */
export function codeIndexHref({ q, page, sharedPage }: CodeIndexQuery): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (page > 1) params.set('page', String(page));
  if (sharedPage > 1) params.set('shared', String(sharedPage));
  const search = params.toString();
  return `/code${search ? `?${search}` : ''}`;
}

/** Who a shared project belongs to, as the Owner column says it. */
export function ownerLabel(project: ProjectListItem): string {
  return project.ownerName ?? 'Someone';
}

/** Blank rows that pad a page with rows to the table's full height (none when there are no rows: the empty message shows). */
export function fillerCount(group: CodeIndexGroup): number {
  return group.paging.rows.length === 0 ? 0 : Math.max(0, group.size - group.paging.rows.length);
}
