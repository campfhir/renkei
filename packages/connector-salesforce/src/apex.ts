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
