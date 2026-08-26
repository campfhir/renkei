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
  /**
   * A recipient address on the To line. Client-side for a harder reason
   * than subject: Exchange does not support $filter on the recipient
   * COLLECTIONS at all — no `toRecipients/any(...)`, no equality — so there
   * is no server-side form of this question to get right. $search can ask
   * it (`to:someone@example.com`), but $search and $filter are mutually
   * exclusive on mail, so reaching for it would cost every other filter in
   * this type. Matching over the pages keeps them all.
   */
  to?: string;
  /** A recipient address on the Cc line. Client-side, exactly as `to`. */
  cc?: string;
}

/**
 * Whether anything here has to be matched after fetching rather than by
 * Exchange. Callers use it to widen their page size and scan budget, since
 * a client-side filter can discard most of a page.
 */
export function hasClientSideFilter(filters: MailSearchFilters): boolean {
  return Boolean(filters.subjectContains || filters.to || filters.cc);
}

/**
 * The $select a client-side match needs on top of what the caller wanted.
 *
 * Recipient collections are only pulled when a recipient filter is
 * actually set: they are the heaviest thing on a message summary, and a
 * survey of 1000 messages should not carry them for nothing.
 */
export function clientSideSelect(filters: MailSearchFilters, base: string): string {
  const fields = base.split(',').filter(Boolean);
  const need = (field: string) => {
    if (!fields.includes(field)) fields.push(field);
  };
  if (filters.subjectContains) need('subject');
  if (filters.to) need('toRecipients');
  if (filters.cc) need('ccRecipients');
  return fields.join(',');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Every address on a recipient collection, lowercased.
 *
 * Narrowed at each hop rather than asserted: this reads Graph's JSON, and a
 * $select that forgot the field or a shape that changed should yield no
 * addresses — which fails the match closed — instead of throwing.
 */
function addressesOf(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const addresses: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const emailAddress = entry.emailAddress;
    if (!isRecord(emailAddress)) continue;
    const address = emailAddress.address;
    if (typeof address === 'string' && address) addresses.push(address.toLowerCase());
  }
  return addresses;
}

/**
 * The filters Exchange could not apply, applied here.
 *
 * ONE implementation on purpose. This used to be written out separately in
 * the web tool and in the worker's job expansion, which is survivable for a
 * search — the worst case is a thin page — and is not survivable for a bulk
 * job: a filter the expansion ignores selects the wrong messages, and the
 * job then deletes or moves them. A caller that forgets to run this at all
 * still gets that, so the field docs above say client-side out loud.
 *
 * Recipient matches are exact on the address and case-insensitive, the same
 * semantic `from` carries server-side. A display name is not an address and
 * does not match.
 */
export function matchesClientSide(
  message: Record<string, unknown>,
  filters: MailSearchFilters
): boolean {
  if (filters.subjectContains) {
    const subject = typeof message.subject === 'string' ? message.subject : '';
    if (!subject.toLowerCase().includes(filters.subjectContains.toLowerCase())) return false;
  }
  if (filters.to) {
    if (!addressesOf(message.toRecipients).includes(filters.to.trim().toLowerCase())) return false;
  }
  if (filters.cc) {
    if (!addressesOf(message.ccRecipients).includes(filters.cc.trim().toLowerCase())) return false;
  }
  return true;
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
