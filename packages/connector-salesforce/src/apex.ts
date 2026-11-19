/**
 * Reading Apex source a window at a time.
 *
 * A class or trigger body can run to hundreds of thousands of characters,
 * and a tool result is cut at a fixed length (30 000 characters for an
 * agent run) from the front. Read whole through SOQL, as one JSON string
 * with its newlines escaped, a large class showed its first few hundred
 * lines and nothing past them could be reached: there is no page of a
 * single field. So source is served as numbered lines, a window at a time,
 * each answer saying where it stopped and where the next window starts,
 * and `findInSource` names the lines that mention something so a reader
 * can jump straight to the middle of a file.
 */

import { soqlContains, soqlString } from './soql';

export type ApexKind = 'class' | 'trigger';

/** The sObject that holds each kind's source. */
export const APEX_OBJECT: Record<ApexKind, 'ApexClass' | 'ApexTrigger'> = {
  class: 'ApexClass',
  trigger: 'ApexTrigger',
};

/**
 * The most source one window holds: room under the run's 30 000-character
 * result bound for the header and the line numbers' gutter.
 */
export const APEX_WINDOW_CHARS = 24_000;

/** One line longer than this (minified or generated code) is cut, saying so. */
export const APEX_LINE_CHARS = 2_000;

/** How many matching lines `findInSource` names before saying there are more. */
export const APEX_FIND_HITS = 60;

/** What Salesforce returns as the Body of managed-package code it does not show. */
export const HIDDEN_BODY = '(hidden)';

/** The source's lines, whatever line endings it was saved with. */
export function sourceLines(body: string): string[] {
  const lines = body.split(/\r\n|\r|\n/);
  // A trailing newline is not a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface SourceWindow {
  /** The lines: numbered (`  42  code`), or exactly as saved with `lineNumbers: false`. */
  text: string;
  /** 1-based, inclusive. */
  firstLine: number;
  lastLine: number;
  totalLines: number;
  /** Where the next window starts, or null when this one reached the end asked for. */
  nextStart: number | null;
  /** Set when the window stopped at the size bound before the end asked for. */
  stoppedAtLimit: boolean;
  /**
   * Plain windows only: a line too long for any window, cut to fit, its
   * number and full length — said beside the source, never written into it.
   */
  cutLine: { line: number; length: number } | null;
}

function clipLine(line: string): string {
  return line.length > APEX_LINE_CHARS
    ? `${line.slice(0, APEX_LINE_CHARS)} … [line cut: ${line.length - APEX_LINE_CHARS} more characters]`
    : line;
}

/**
 * Lines `startLine`..`endLine` of `body` (1-based, inclusive, both
 * optional), numbered unless `lineNumbers` is false, stopping early when the next line would take the
 * window past `maxChars`; always at least one line, so a reader moving by
 * `nextStart` always moves. A start past the end is an error to say back,
 * not an empty window.
 *
 * Without line numbers the text is the source exactly as saved, nothing
 * added — the form to copy from, since a number or a marker in the text
 * would be read as part of the class. A numbered window cuts an
 * overlong line in place, saying so on the line; a plain one cuts it only
 * when it alone overfills the window, and says so in `cutLine`.
 */
export function sourceWindow(
  body: string,
  range: { startLine?: number; endLine?: number; maxChars?: number; lineNumbers?: boolean } = {}
): SourceWindow | { error: string } {
  const numbers = range.lineNumbers ?? true;
  const lines = sourceLines(body);
  const total = lines.length;
  const start = Math.max(1, Math.floor(range.startLine ?? 1));
  const end = Math.min(total, Math.floor(range.endLine ?? total));
  const maxChars = range.maxChars ?? APEX_WINDOW_CHARS;
  if (start > total) {
    return {
      error: `It has ${total} line${total === 1 ? '' : 's'}; line ${start} is past the end.`,
    };
  }
  if (end < start) return { error: `endLine ${end} is before startLine ${start}.` };
  const width = String(end).length;
  const out: string[] = [];
  let used = 0;
  let line = start;
  let cutLine: SourceWindow['cutLine'] = null;
  for (; line <= end; line += 1) {
    const source = lines[line - 1];
    let shown = numbers ? `${String(line).padStart(width)}  ${clipLine(source)}` : source;
    if (out.length > 0 && used + shown.length + 1 > maxChars) break;
    if (!numbers && shown.length > maxChars) {
      cutLine = { line, length: source.length };
      shown = shown.slice(0, maxChars);
    }
    out.push(shown);
    used += shown.length + 1;
  }
  const lastLine = line - 1;
  const stoppedAtLimit = lastLine < end;
  return {
    text: out.join('\n'),
    firstLine: start,
    lastLine,
    totalLines: total,
    nextStart: stoppedAtLimit ? lastLine + 1 : null,
    stoppedAtLimit,
    cutLine,
  };
}

export interface SourceHit {
  line: number;
  text: string;
}

/**
 * The lines that contain `needle`, case-insensitively (Apex is not case
 * sensitive), first `maxHits` of them, each trimmed and cut short.
 */
export function findInSource(
  body: string,
  needle: string,
  maxHits = APEX_FIND_HITS
): { hits: SourceHit[]; total: number } {
  const wanted = needle.toLowerCase();
  const hits: SourceHit[] = [];
  let total = 0;
  sourceLines(body).forEach((text, index) => {
    if (!text.toLowerCase().includes(wanted)) return;
    total += 1;
    if (hits.length < maxHits) {
      const trimmed = text.trim();
      hits.push({
        line: index + 1,
        text: trimmed.length > 200 ? `${trimmed.slice(0, 200)} …` : trimmed,
      });
    }
  });
  return { hits, total };
}

/** The SOQL that reads one class or trigger by name, the org's own first. */
export function apexSourceQuery(kind: ApexKind, name: string): string {
  const extra = kind === 'trigger' ? ', TableEnumOrId' : '';
  return (
    `SELECT Id, Name, NamespacePrefix, ApiVersion, Status, Body, LengthWithoutComments, ` +
    `LastModifiedDate, LastModifiedBy.Name${extra} FROM ${APEX_OBJECT[kind]} ` +
    `WHERE Name = ${soqlString(name)} ORDER BY NamespacePrefix NULLS FIRST LIMIT 5`
  );
}

/** The SOQL that suggests names when nothing is called exactly that. */
export function apexNameSuggestionQuery(kind: ApexKind, fragment: string): string {
  return (
    `SELECT Name, NamespacePrefix FROM ${APEX_OBJECT[kind]} ` +
    `WHERE Name LIKE ${soqlContains(fragment)} ORDER BY Name LIMIT 10`
  );
}

/** How many classes or triggers one listing names by default, and at most. */
export const APEX_LIST_DEFAULT = 200;
export const APEX_LIST_MAX = 1_000;

/** A trigger's events, in the order Salesforce runs them, by the field that flags each. */
const TRIGGER_EVENTS: readonly [field: string, event: string][] = [
  ['UsageBeforeInsert', 'before insert'],
  ['UsageAfterInsert', 'after insert'],
  ['UsageBeforeUpdate', 'before update'],
  ['UsageAfterUpdate', 'after update'],
  ['UsageBeforeDelete', 'before delete'],
  ['UsageAfterDelete', 'after delete'],
  ['UsageAfterUndelete', 'after undelete'],
];

export interface ApexListFilter {
  /** Part of the name, case-insensitively. */
  nameContains?: string;
  /** Triggers only: the object they fire on (TableEnumOrId). */
  object?: string;
  /** Include installed packages' code; by default only the org's own. */
  includePackages?: boolean;
  /** Names after this one, for the next page (keyset on Name). */
  afterName?: string;
}

/**
 * The SOQL that lists classes or triggers by name, without their bodies.
 *
 * No LIMIT: the first page Salesforce answers (up to 2 000 rows of a few
 * short fields) carries the exact count of everything that matches in
 * `totalSize`, at the cost of one call, and the caller shows a page of
 * it. The next page is a keyset (`Name > afterName`), not an OFFSET, so a
 * listing has no 2 000-row ceiling.
 */
export function apexListQuery(kind: ApexKind, filter: ApexListFilter = {}): string {
  const fields = [
    'Id',
    'Name',
    'NamespacePrefix',
    'ApiVersion',
    'Status',
    'LengthWithoutComments',
    'LastModifiedDate',
    'LastModifiedBy.Name',
    ...(kind === 'trigger' ? ['TableEnumOrId', ...TRIGGER_EVENTS.map(([field]) => field)] : []),
  ];
  const where: string[] = [];
  if (!filter.includePackages) where.push('NamespacePrefix = null');
  if (filter.nameContains) where.push(`Name LIKE ${soqlContains(filter.nameContains)}`);
  if (kind === 'trigger' && filter.object)
    where.push(`TableEnumOrId = ${soqlString(filter.object)}`);
  if (filter.afterName) where.push(`Name > ${soqlString(filter.afterName)}`);
  return (
    `SELECT ${fields.join(', ')} FROM ${APEX_OBJECT[kind]}` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY Name, NamespacePrefix NULLS FIRST, Id'
  );
}

/** A trigger record's events, e.g. ['before insert', 'after update']. */
export function triggerEvents(record: Record<string, unknown>): string[] {
  return TRIGGER_EVENTS.filter(([field]) => record[field] === true).map(([, event]) => event);
}

/**
 * The first `limit` of `rows` (sorted by name), widened so a page never
 * ends part-way through one name — two packages can each have a class
 * called the same — since the next page starts after that name.
 * `afterName` is the name the next page starts after, or null when every
 * row Salesforce sent is shown and it said there are no more.
 */
export function apexListPage<T extends { Name?: unknown }>(
  rows: readonly T[],
  limit: number,
  moreOnServer: boolean
): { shown: T[]; afterName: string | null } {
  const nameOf = (row: T) => (typeof row.Name === 'string' ? row.Name : '');
  let end = Math.min(limit, rows.length);
  const boundary = end > 0 ? nameOf(rows[end - 1]).toLowerCase() : '';
  while (end < rows.length && nameOf(rows[end]).toLowerCase() === boundary) end += 1;
  const shown = rows.slice(0, end);
  const more = end < rows.length || moreOnServer;
  return { shown, afterName: more && shown.length > 0 ? nameOf(shown[shown.length - 1]) : null };
}
