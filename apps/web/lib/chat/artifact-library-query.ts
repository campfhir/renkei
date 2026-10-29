/**
 * One page of a person's library, chosen in the database: what they own
 * and what is shared with them, narrowed by kind, by project and by
 * words — a word in the file's name (a substring, so `invoice` finds
 * `invoices-march.csv`) or in its digest, the summary and keywords the
 * organization's model wrote for it (artifact-digest.ts), matched as
 * full-text terms against the indexed `search_vector`. The sealed text
 * is never read: a search costs an indexed predicate, and the browser
 * is sent one page.
 *
 * Owned files come first, newest first, then shared ones — the order the
 * library has always had — whatever the search, so a page is the same
 * page on the way back.
 */

import { getDataStore, type LibraryFilter } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { listGrantedResources } from './access';
import { libraryItems, type LibraryItem } from './artifact-library';
import { LIBRARY_PAGE_SIZE, queryTermsOf, type LibraryQuery } from './artifact-library-params';

export interface LibraryPage {
  /** The page's rows, as the library lists them. */
  artifacts: LibraryItem[];
  /** Files matching the filters, across every page. */
  total: number;
  /** 1-based; the page shown, which is the one `focus` sits on when it was asked for. */
  page: number;
  pageCount: number;
  pageSize: number;
  /** Everything in the library, filters aside — zero is the empty state. */
  libraryCount: number;
  /** The person's own files: how many, and how much they hold. */
  owned: { count: number; bytes: number };
}

export async function queryLibrary(
  viewerSubject: string,
  query: LibraryQuery,
  pageSize: number = LIBRARY_PAGE_SIZE
): Promise<LibraryPage> {
  const store = getDataStore();
  const granted = await listGrantedResources(viewerSubject, 'artifact');
  const sharedIds = granted.map((grant) => grant.resourceId).filter(isUuid);
  const terms = queryTermsOf(query.query);
  const filter: LibraryFilter = {
    viewerSubject,
    sharedIds,
    show: query.show,
    projectId: query.projectId && isUuid(query.projectId) ? query.projectId : null,
    query: terms.length > 0 ? query.query : '',
    terms,
  };

  const [total, owned, sharedCount] = await Promise.all([
    store.artifacts.libraryCount(filter),
    store.artifacts.ownedTotals(viewerSubject),
    store.artifacts.countExisting(sharedIds),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // A link to one file opens to the page it is on: its place in the
  // order is the number of rows that sort before it.
  let page = Math.min(query.page, pageCount);
  if (query.focus && query.page === 1 && isUuid(query.focus)) {
    const before = await store.artifacts.libraryPosition(filter, query.focus);
    if (before !== null) page = Math.floor(before / pageSize) + 1;
  }

  // Owned first, newest first; then shared, newest first.
  const rows = await store.artifacts.libraryRows(filter, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return {
    artifacts: await libraryItems(viewerSubject, rows, () => 'grant'),
    total,
    page,
    pageCount,
    pageSize,
    libraryCount: owned.count + sharedCount,
    owned,
  };
}
