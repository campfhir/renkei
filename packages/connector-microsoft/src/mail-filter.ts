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
 * Filter clause order is load-bearing, not cosmetic: Graph documents that
 * when $filter and $orderby are combined on messages, every $orderby
 * property must also appear in $filter AND must come before any property
 * that isn't in the $orderby — otherwise Exchange answers 400
 * InefficientFilter ("The restriction or sort order is too complex for this
 * operation"). Since we always order by receivedDateTime, its clauses lead.
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
