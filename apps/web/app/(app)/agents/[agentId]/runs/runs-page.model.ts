/**
 * Paging the runs table: which page the URL asks for, which rows of the
 * newest-first list that is, and where Previous and Next lead. Pure; the
 * page reads one row past the page (PAGE_SIZE + 1) so it knows whether a
 * next page exists without counting every run.
 *
 * The page number rides in the URL (?page=) beside the status tab and the
 * search, so a page stays linkable; changing the tab or the search starts
 * again from page 1 (their links carry no page).
 */

export const PAGE_SIZE = 50;

/** The URL's ?page=, as a whole number from 1; anything else is page 1. */
export function pageFromParam(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return 1;
  const page = Number(raw.trim());
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/** The rows to ask the store for: this page's, plus one to see past it. */
export function pageQuery(page: number): { limit: number; offset: number } {
  return { limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE };
}

export interface RunsPageWindow<T> {
  /** The rows to show: at most PAGE_SIZE. */
  rows: T[];
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** "Runs 51–100", or null when the page is empty. */
  range: string | null;
}

/** What the page shows, from what the store returned for pageQuery(page). */
export function pageWindow<T>(fetched: readonly T[], page: number): RunsPageWindow<T> {
  const rows = fetched.slice(0, PAGE_SIZE);
  const first = (page - 1) * PAGE_SIZE + 1;
  return {
    rows,
    page,
    hasPrevious: page > 1,
    hasNext: fetched.length > PAGE_SIZE,
    range: rows.length > 0 ? `Runs ${first}–${first + rows.length - 1}` : null,
  };
}

/** A link to `page` of the runs list, keeping its status tab and search. */
export function runsPageHref(
  basePath: string,
  { status, q, page }: { status?: string; q?: string; page: number }
): string {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  return search ? `${basePath}?${search}` : basePath;
}
