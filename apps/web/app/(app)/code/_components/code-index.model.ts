/**
 * The Code page's project list: a search box over name, repository,
 * description and owner, and pages of PAGE_SIZE. Searching returns to the
 * first page; a page past the end (a search that narrowed) is clamped.
 * The page loads every project; this narrows and slices them.
 */

import type { ProjectListItem } from '@/lib/chat/sidebar';

export const PAGE_SIZE = 10;

export interface CodeIndexState {
  query: string;
  /** Zero-based, per group. */
  pages: { mine: number; shared: number };
}

export type CodeIndexAction =
  | { type: 'query'; value: string }
  | { type: 'page'; group: 'mine' | 'shared'; page: number };

export const initialCodeIndex: CodeIndexState = { query: '', pages: { mine: 0, shared: 0 } };

export function codeIndexReducer(state: CodeIndexState, action: CodeIndexAction): CodeIndexState {
  switch (action.type) {
    case 'query':
      return { query: action.value, pages: { mine: 0, shared: 0 } };
    case 'page':
      return { ...state, pages: { ...state.pages, [action.group]: Math.max(0, action.page) } };
  }
}

/** Every word typed must appear somewhere in the project's name, repository, description or owner. */
export function matchingProjects(projects: ProjectListItem[], query: string): ProjectListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return projects;
  return projects.filter((project) => {
    const haystack = [project.name, project.repoFullName, project.description, project.ownerName]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export interface ProjectsPage {
  items: ProjectListItem[];
  /** Matches before paging. */
  total: number;
  page: number;
  pageCount: number;
  /** 1-based "from–to" of the rows shown, or null with none. */
  range: [number, number] | null;
}

export function projectsPage(
  projects: ProjectListItem[],
  state: CodeIndexState,
  group: 'mine' | 'shared'
): ProjectsPage {
  const matches = matchingProjects(projects, state.query);
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(state.pages[group], pageCount - 1);
  const items = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return {
    items,
    total: matches.length,
    page,
    pageCount,
    range: items.length ? [page * PAGE_SIZE + 1, page * PAGE_SIZE + items.length] : null,
  };
}

/** What an empty group says: nothing yet, or nothing matching the search. */
export function emptyKind(all: ProjectListItem[], query: string): 'none' | 'no-match' {
  return all.length === 0 || query.trim() === '' ? 'none' : 'no-match';
}
