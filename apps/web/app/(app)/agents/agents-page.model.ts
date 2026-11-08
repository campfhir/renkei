/**
 * Paging the Agents page, ten at a time: the "In flight" overview
 * (?inflight=) and the agent cards (?page=) page independently, each link
 * keeping the other's place. Pure; the page has every agent in hand
 * already, so a page is a slice, and a page past the end shows the last.
 *
 * The cards page as one list — the viewer's own agents, then the ones
 * shared with them — so the "Shared with you" heading shows on whichever
 * page reaches it.
 */

export { pageFromParam } from './[agentId]/runs/runs-page.model';

export const AGENTS_PAGE_SIZE = 10;

export interface ListPage<T> {
  rows: T[];
  /** The page shown: the one asked for, or the last when that is past the end. */
  page: number;
  pageCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** "11–20 of 34", or null when there is nothing to page. */
  range: string | null;
}

/** Page `requested` of `items`, `size` to a page. */
export function listPage<T>(
  items: readonly T[],
  requested: number,
  size = AGENTS_PAGE_SIZE
): ListPage<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(1, requested), pageCount);
  const start = (page - 1) * size;
  const rows = items.slice(start, start + size);
  return {
    rows,
    page,
    pageCount,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
    range: items.length === 0 ? null : `${start + 1}–${start + rows.length} of ${items.length}`,
  };
}

/**
 * Page `requested` of the cards: own agents first, then shared ones, cut
 * where the page falls — `agents` and `shared` are what this page holds of
 * each.
 */
export function cardsPage<A, S>(
  agents: readonly A[],
  shared: readonly S[],
  requested: number
): { agents: A[]; shared: S[]; paging: ListPage<A | S> } {
  const paging = listPage<A | S>([...agents, ...shared], requested);
  const start = (paging.page - 1) * AGENTS_PAGE_SIZE;
  const end = start + paging.rows.length;
  return {
    agents: agents.slice(start, Math.min(end, agents.length)),
    shared: shared.slice(Math.max(0, start - agents.length), Math.max(0, end - agents.length)),
    paging,
  };
}

/**
 * A link to the Agents page at these two pages (page 1 left out of the
 * URL), landing at `hash` when given, e.g. the cards' anchor.
 */
export function agentsPageHref(
  { inflight, page }: { inflight: number; page: number },
  hash?: string
): string {
  const params = new URLSearchParams();
  if (inflight > 1) params.set('inflight', String(inflight));
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  return `/agents${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`;
}
