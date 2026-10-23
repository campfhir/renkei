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

import type { Kysely, ExpressionBuilder } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@renkei/db';
import { listGrantedResources } from './access';
import { libraryItems, type LibraryItem } from './artifact-library';
import {
  LIBRARY_PAGE_SIZE,
  queryTermsOf,
  type LibraryFilters,
  type LibraryQuery,
} from './artifact-library-params';

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

const COLUMNS = [
  'id',
  'owner_subject',
  'chat_id',
  'filename',
  'content_type',
  'size_bytes',
  'extract_status',
  'origin',
  'summary',
  'keywords',
  'digest_status',
  'created_at',
  'updated_at',
] as const;

/** `%` and `_` in a term are characters to find, not wildcards. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The rows the filters admit. Owned rows and shared rows are told apart
 * by `owner_subject`; a kind (`uploaded`, `generated`) is the owner's
 * files of that origin, `shared` is the rest.
 */
function filtersWhere(
  eb: ExpressionBuilder<DB, 'artifacts'>,
  viewerSubject: string,
  sharedIds: string[],
  filters: LibraryFilters
) {
  const owned = eb('owner_subject', '=', viewerSubject);
  const shared = sharedIds.length > 0 ? eb('id', 'in', sharedIds) : eb.val(false);
  const conditions = [];
  switch (filters.show) {
    case 'all':
      conditions.push(eb.or([owned, shared]));
      break;
    case 'uploaded':
      conditions.push(eb.and([owned, eb('origin', '=', 'upload')]));
      break;
    case 'generated':
      conditions.push(eb.and([owned, eb('origin', '=', 'model')]));
      break;
    case 'shared':
      conditions.push(shared);
      break;
  }
  if (filters.projectId) {
    conditions.push(
      eb(
        'id',
        'in',
        eb
          .selectFrom('artifact_references')
          .select('artifact_id')
          .where('project_id', '=', filters.projectId)
      )
    );
  }
  const terms = queryTermsOf(filters.query);
  if (terms.length > 0) {
    const byName = eb.and(terms.map((term) => eb('filename', 'ilike', likePattern(term))));
    const byDigest = sql<boolean>`search_vector @@ websearch_to_tsquery('english', ${filters.query})`;
    conditions.push(eb.or([byName, byDigest]));
  }
  return eb.and(conditions);
}

export async function queryLibrary(
  db: Kysely<DB>,
  viewerSubject: string,
  query: LibraryQuery,
  pageSize: number = LIBRARY_PAGE_SIZE
): Promise<LibraryPage> {
  const granted = await listGrantedResources(db, viewerSubject, 'artifact');
  const sharedIds = granted.map((grant) => grant.resourceId);
  const where = (eb: ExpressionBuilder<DB, 'artifacts'>) =>
    filtersWhere(eb, viewerSubject, sharedIds, query);
  // Owned first, newest first; then shared, newest first.
  const ownedFirst = sql`(owner_subject = ${viewerSubject}) desc`;

  const [counted, ownedAgg, sharedCount] = await Promise.all([
    db
      .selectFrom('artifacts')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where(where)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('artifacts')
      .select((eb) => [
        eb.fn.countAll<number>().as('count'),
        eb.fn.coalesce(eb.fn.sum<number>('size_bytes'), sql<number>`0`).as('bytes'),
      ])
      .where('owner_subject', '=', viewerSubject)
      .executeTakeFirstOrThrow(),
    sharedIds.length > 0
      ? db
          .selectFrom('artifacts')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('id', 'in', sharedIds)
          .executeTakeFirstOrThrow()
      : Promise.resolve({ count: 0 }),
  ]);
  const total = Number(counted.count);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // A link to one file opens to the page it is on: its place in the
  // order is the number of rows that sort before it.
  let page = Math.min(query.page, pageCount);
  if (query.focus && query.page === 1) {
    const focused = await db
      .selectFrom('artifacts')
      .select(['owner_subject', 'created_at'])
      .where('id', '=', query.focus)
      .where(where)
      .executeTakeFirst();
    if (focused) {
      const focusOwned = focused.owner_subject === viewerSubject;
      const before = await db
        .selectFrom('artifacts')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where(where)
        .where((eb) =>
          focusOwned
            ? eb.and([
                eb('owner_subject', '=', viewerSubject),
                eb('created_at', '>', focused.created_at),
              ])
            : eb.or([
                eb('owner_subject', '=', viewerSubject),
                eb('created_at', '>', focused.created_at),
              ])
        )
        .executeTakeFirstOrThrow();
      page = Math.floor(Number(before.count) / pageSize) + 1;
    }
  }

  const rows = await db
    .selectFrom('artifacts')
    .select(COLUMNS)
    .where(where)
    .orderBy(ownedFirst)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'asc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();

  return {
    artifacts: await libraryItems(db, viewerSubject, rows, () => 'grant'),
    total,
    page,
    pageCount,
    pageSize,
    libraryCount: Number(ownedAgg.count) + Number(sharedCount.count),
    owned: { count: Number(ownedAgg.count), bytes: Number(ownedAgg.bytes) },
  };
}
