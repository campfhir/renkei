/**
 * The Code page's project list: one table — mine first, then the ones
 * shared with me — searched with `?q=` and paged ten at a time with
 * `?page=`, both in the URL so a view is linkable (the shape the runs list
 * has). The page loads every project the person can open; this narrows
 * and slices them, and says where the links go. Pure.
 */

import type { ProjectListItem } from '@/lib/chat/sidebar';
import { listPage, pageFromParam, type ListPage } from '../../agents/agents-page.model';

export { pageFromParam };

export interface CodeIndexQuery {
  /** The search text, trimmed; empty for none. */
  q: string;
  /** 1-based, as asked (the view clamps it). */
  page: number;
}

/** The query a request's search params spell: text trimmed, a bad page as the first. */
export function codeIndexQuery(params: { q?: string; page?: string }): CodeIndexQuery {
  return { q: (params.q ?? '').trim().slice(0, 200), page: pageFromParam(params.page) };
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

export interface CodeIndexView {
  paging: ListPage<ProjectListItem>;
  /** Why the list is empty, when it is: nothing exists yet, or the search found nothing. */
  empty: 'none' | 'no-match' | null;
}

export function codeIndexView(projects: ProjectListItem[], query: CodeIndexQuery): CodeIndexView {
  // Mine first, then shared, each in the order the page loaded them.
  const ordered = [
    ...projects.filter((project) => project.role === 'owner'),
    ...projects.filter((project) => project.role !== 'owner'),
  ];
  const matches = matchingProjects(ordered, query.q);
  return {
    paging: listPage(matches, query.page),
    empty: matches.length > 0 ? null : projects.length === 0 ? 'none' : 'no-match',
  };
}

/** A link to the list at this search and page (page 1 and an empty search left out of the URL). */
export function codeIndexHref({ q, page }: CodeIndexQuery): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  return `/code${search ? `?${search}` : ''}`;
}

/** What the Owner column says: "You" on mine, the person's name on a shared one. */
export function ownerLabel(project: ProjectListItem): string {
  return project.role === 'owner' ? 'You' : (project.ownerName ?? 'Someone');
}
