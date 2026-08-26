/**
 * Building a Graph mail query path from structured filters — shared by the
 * web's outlook_bulk_search_messages and the worker's mail bulk jobs (which
 * expand a filter selection server-side before acting on it).
 */

export interface MailSearchFilters {
  /** Folder id or well-known name; unset searches the whole mailbox. */
  folder?: string;
  isRead?: boolean;
  flagStatus?: string;
  /** Messages carrying ALL of these categories. */
  categories?: string[];
  hasAttachments?: boolean;
  /** Exact sender address. */
  from?: string;
  /** ISO-8601 — only messages received on/after this time. */
  receivedAfter?: string;
  /** ISO-8601 — only messages received before this time. */
  receivedBefore?: string;
  /**
   * Substring match on the subject. Deliberately NOT compiled into $filter:
   * Graph's mail $filter has no working contains() for subject (it 400s),
   * and $search — which does support subject: — cannot be combined with
   * $filter on mail at all. Callers apply this client-side over the pages,
   * which also gets true substring semantics rather than $search's
   * word/prefix tokenization.
   */
  subjectContains?: string;
}

export interface MailQueryOptions {
  top: number;
  withCount?: boolean;
  /** $select list; defaults to the bulk-search projection. */
  select?: string;
}

/**
 * A lower bound old enough to exclude nothing.
 *
 * Its only job is to put `receivedDateTime` INTO the filter — see the rule
 * below — for a search that did not ask for a date range. Exchange's own
 * minimum is far earlier, so no real message is cut off by it.
 */
const OPEN_LOWER_BOUND = '1970-01-01T00:00:00Z';

/**
 * Filter clause order is load-bearing, not cosmetic: Graph documents that
 * when $filter and $orderby are combined on messages, every $orderby
 * property must also appear in $filter AND must come before any property
 * that isn't in the $orderby — otherwise Exchange answers 400
 * InefficientFilter ("The restriction or sort order is too complex for this
 * operation"). Since we always order by receivedDateTime, its clauses lead.
 *
 * Both halves of that rule matter, and only the ORDER half used to be
 * implemented. When no date range was asked for there was no
 * receivedDateTime clause to lead with, so the $orderby property was absent
 * from $filter entirely and Exchange refused the query. Live reproduction,
 * 2026-08-26: `{from}` alone, `{from, hasAttachments}` and `{flagStatus}`
 * each answered a bare 400, while `{isRead}` alone succeeded — a plain
 * scalar restriction survives the combination where a restriction on a
 * complex path (from/…, flag/…, a categories/any lambda) does not.
 *
 * So the fix is to satisfy the rule for EVERY filtered query rather than
 * only the ones that happen to name a date. Doing it uniformly is the
 * point: the alternative is classifying each clause as scalar-or-complex,
 * which silently reintroduces this bug the first time somebody adds a
 * filter and classifies it wrong.
 */
export function buildMailQueryPath(filters: MailSearchFilters, options: MailQueryOptions): string {
  const quote = (value: string) => value.replace(/'/g, "''");
  const basePath = filters.folder
    ? `/me/mailFolders/${encodeURIComponent(filters.folder)}/messages`
    : '/me/messages';

  const dateFilters: string[] = [];
  if (filters.receivedAfter) dateFilters.push(`receivedDateTime ge ${filters.receivedAfter}`);
  if (filters.receivedBefore) dateFilters.push(`receivedDateTime lt ${filters.receivedBefore}`);

  const otherFilters: string[] = [];
  if (typeof filters.isRead === 'boolean') otherFilters.push(`isRead eq ${filters.isRead}`);
  if (filters.flagStatus) otherFilters.push(`flag/flagStatus eq '${quote(filters.flagStatus)}'`);
  for (const category of filters.categories ?? []) {
    if (typeof category === 'string' && category) {
      otherFilters.push(`categories/any(c:c eq '${quote(category)}')`);
    }
  }
  if (typeof filters.hasAttachments === 'boolean') {
    otherFilters.push(`hasAttachments eq ${filters.hasAttachments}`);
  }
  if (filters.from) otherFilters.push(`from/emailAddress/address eq '${quote(filters.from)}'`);
  // subjectContains is deliberately absent — see the field's doc comment.

  // The $orderby property has to be in the filter whenever the filter
  // exists at all. An unfiltered query is left alone: with no $filter there
  // is no combination for Exchange to object to, and a bare $orderby is
  // fine on its own.
  if (dateFilters.length === 0 && otherFilters.length > 0) {
    dateFilters.push(`receivedDateTime ge ${OPEN_LOWER_BOUND}`);
  }
  const clauses = [...dateFilters, ...otherFilters];

  const parts = [
    `$top=${options.top}`,
    '$orderby=receivedDateTime desc',
    `$select=${options.select ?? 'id,subject,from,receivedDateTime,isRead,flag,categories'}`,
  ];
  if (clauses.length > 0) parts.push(`$filter=${encodeURIComponent(clauses.join(' and '))}`);
  if (options.withCount) parts.push('$count=true');
  return `${basePath}?${parts.join('&')}`;
}
