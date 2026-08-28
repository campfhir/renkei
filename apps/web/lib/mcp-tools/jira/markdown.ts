/**
 * Markdown -> Atlassian Document Format.
 *
 * The inverse of ./adf.ts, and deliberately the narrower of the two. Reading
 * has to cope with whatever a Jira instance already contains, so adf.ts
 * handles every node type it might meet. Writing only has to cope with what a
 * model produces, so this handles the common subset and treats everything else
 * as literal text.
 *
 * That asymmetry is the safety property: an unrecognized construct becomes
 * visible prose in the issue, never a dropped sentence and never a malformed
 * document that Jira rejects with a validation error the model cannot act on.
 *
 * Not supported, by choice: panels, media, and status lozenges — each needs
 * instance-specific IDs (file references, colour tokens) a model would have
 * to invent. GFM tables ARE supported: they need no such IDs, adf.ts has
 * always been able to READ them, and a model asked for a comparison writes
 * one whether or not the writer understands it — unsupported, a table
 * arrived as a wall of pipe characters. Mentions ARE supported, deliberately
 * not by invention: Jira's own wiki-markup mention syntax — any of
 * `[~accountid:ID]`, `[~ID]` or `[~557058:uuid]` — becomes a real ADF
 * `mention` node in processMentions below, so a caller can only mention an
 * account id it already has (from jira_search_users), never a guessed one.
 * Anything else in brackets stays literal text.
 */

/** A mark applied to a text node — bold, italic, code, link, and so on. */
interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
}

export interface AdfDocument {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/**
 * Characters a backslash may escape. Each is swapped for a private-use
 * codepoint before parsing so it cannot be read as a delimiter, then swapped
 * back when the text node is built.
 *
 * The mapping is positional rather than sequential — an escape carries its own
 * identity — so restoring is stateless. An earlier version tracked position in
 * a shared counter, which desynchronized the moment a blockquote recursed.
 */
// `|` is last on purpose: the mapping is positional, so appending a
// character keeps every existing escape's codepoint stable. It is here so a
// pipe inside a table cell can be written `\|` and survive the row split.
const ESCAPABLE = '\\`*_~[]()#-+>|';
const PRIVATE_USE_BASE = 0xe000;

/** Derived from ESCAPABLE so the two cannot drift apart. */
const MASKED = new RegExp(
  `[\\u${PRIVATE_USE_BASE.toString(16)}-\\u${(PRIVATE_USE_BASE + ESCAPABLE.length - 1).toString(16)}]`,
  'g'
);

const FENCE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
/** The `|---|:--:|` row directly under a table's header. Alignment colons are
 *  accepted and then ignored: ADF cells carry no alignment attribute. */
const TABLE_DELIMITER = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = maskEscapes(markdown).replace(/\r\n?/g, '\n').split('\n');
  const content = parseBlocks(lines);
  // Post-process to convert @accountId patterns to mention nodes
  return { version: 1, type: 'doc', content: processMentions(content) };
}

/** True when the source would produce a document Jira treats as empty. */
export function isBlankMarkdown(markdown: string): boolean {
  return markdown.trim().length === 0;
}

// ------------------------------------------------------------------ escapes

function maskEscapes(source: string): string {
  return source.replace(/\\(.)/g, (match, char: string) => {
    const index = ESCAPABLE.indexOf(char);
    return index === -1 ? match : String.fromCharCode(PRIVATE_USE_BASE + index);
  });
}

function unmaskEscapes(text: string): string {
  return text.replace(MASKED, (char) => ESCAPABLE[char.charCodeAt(0) - PRIVATE_USE_BASE] ?? char);
}

// ------------------------------------------------------------------- blocks

function parseBlocks(lines: readonly string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      // An unterminated fence runs to the end of input rather than failing —
      // models drop the closing fence often enough that rejecting is worse.
      i += 1;
      nodes.push(codeBlock(body.join('\n'), fence[1] ?? ''));
      continue;
    }

    if (RULE.test(line)) {
      nodes.push({ type: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push({
        type: 'heading',
        attrs: { level: (heading[1] ?? '#').length },
        content: parseInline(heading[2] ?? '', []),
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) {
        body.push(QUOTE.exec(lines[i] ?? '')?.[1] ?? '');
        i += 1;
      }
      nodes.push({ type: 'blockquote', content: parseBlocks(body) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const rows: string[] = [line];
      i += 2; // header + delimiter
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      nodes.push(parseTable(rows));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i] ?? '')) {
        items.push(lines[i] ?? '');
        i += 1;
      }
      nodes.push(parseList(items));
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() === '' || startsBlock(lines, i)) break;
      body.push(next.trim());
      i += 1;
    }
    nodes.push({ type: 'paragraph', content: parseInline(body.join(' '), []) });
  }

  return nodes;
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, index)
  );
}

/**
 * A table begins only where a pipe-bearing line is followed by a delimiter
 * row. Requiring the pair is what keeps ordinary prose containing a pipe
 * ("5001 | 50001") from being torn into cells.
 */
function isTableStart(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? '';
  const next = lines[index + 1];
  return line.includes('|') && next !== undefined && TABLE_DELIMITER.test(next);
}

/** `| a | b |` -> ['a', 'b'], tolerating the optional outer pipes. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  // Escapes were masked into private-use characters before parsing, so a
  // literal split can't be fooled by an escaped pipe inside a cell.
  return text.split('|').map((cell) => cell.trim());
}

function tableCell(text: string, header: boolean): AdfNode {
  const inline = parseInline(text, []);
  return {
    type: header ? 'tableHeader' : 'tableCell',
    attrs: {},
    // A cell must hold block content, and an empty cell still needs its
    // paragraph — ADF rejects a cell with no content at all.
    content: [inline.length > 0 ? { type: 'paragraph', content: inline } : { type: 'paragraph' }],
  };
}

function parseTable(rows: readonly string[]): AdfNode {
  const header = splitRow(rows[0] ?? '');
  const width = header.length;
  const content: AdfNode[] = [
    { type: 'tableRow', content: header.map((cell) => tableCell(cell, true)) },
  ];

  for (const row of rows.slice(1)) {
    const cells = splitRow(row);
    // Ragged rows are normalized rather than rejected: GFM pads short rows
    // and drops extra cells, and a model miscounting pipes should not cost
    // the whole document.
    const padded = Array.from({ length: width }, (_unused, index) => cells[index] ?? '');
    content.push({ type: 'tableRow', content: padded.map((cell) => tableCell(cell, false)) });
  }

  return {
    type: 'table',
    attrs: { isNumberColumnEnabled: false, layout: 'default' },
    content,
  };
}

function codeBlock(body: string, language: string): AdfNode {
  // Code is literal, so escapes are unmasked without being interpreted.
  const text = unmaskEscapes(body);
  return {
    type: 'codeBlock',
    ...(language === '' ? {} : { attrs: { language } }),
    ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
  };
}

/**
 * Builds one list level and recurses for deeper indentation.
 *
 * Nesting is by relative indent rather than a fixed step, because models mix
 * two- and four-space indents freely. Any line indented further than the
 * level's first item belongs to that item's sublist.
 *
 * Two model habits are normalized rather than rendered literally:
 *
 * An item with no text of its own whose only content is a nested list — a
 * model faking a labeled section ("1." over an indented "1. Request") —
 * would render as an empty numbered row with its children demoted a level
 * ("1." then "a. Request"). The empty wrapper is never what anyone meant,
 * so its children are hoisted into this level; a list that is nothing but
 * one wrapper hands over to the nested list entirely, keeping its kind.
 *
 * And an ordered list that starts past 1 — the tail of a list a blank line
 * or paragraph split in two — keeps its starting number via the `order`
 * attribute instead of silently renumbering from 1 (adfToMarkdown already
 * reads that attribute back).
 */
function parseList(lines: readonly string[]): AdfNode {
  const first = LIST_ITEM.exec(lines[0] ?? '');
  const baseIndent = (first?.[1] ?? '').length;
  const ordered = first?.[3] !== undefined;
  const start = ordered ? Number.parseInt(first?.[3] ?? '1', 10) : 1;

  const entries: { item?: AdfNode; hoisted?: AdfNode }[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i] ?? '');
    if (!match) {
      i += 1;
      continue;
    }

    const inline = parseInline(match[4] ?? '', []);
    i += 1;

    const nested: string[] = [];
    while (i < lines.length) {
      const ahead = LIST_ITEM.exec(lines[i] ?? '');
      if (!ahead || (ahead[1] ?? '').length <= baseIndent) break;
      nested.push(lines[i] ?? '');
      i += 1;
    }
    const sublist = nested.length > 0 ? parseList(nested) : null;

    if (inline.length === 0 && sublist) {
      entries.push({ hoisted: sublist });
      continue;
    }

    const content: AdfNode[] = [{ type: 'paragraph', content: inline }];
    if (sublist) {
      content.push(sublist);
    }
    entries.push({ item: { type: 'listItem', content } });
  }

  const [only] = entries;
  if (entries.length === 1 && only?.hoisted) {
    return only.hoisted;
  }

  const items = entries.flatMap((entry) => entry.item ?? entry.hoisted?.content ?? []);
  return {
    type: ordered ? 'orderedList' : 'bulletList',
    ...(ordered && start > 1 ? { attrs: { order: start } } : {}),
    content: items,
  };
}

// ------------------------------------------------------------------- inline

interface InlinePattern {
  regex: RegExp;
  /** Builds the mark added to everything inside the match. */
  mark: (match: RegExpExecArray) => AdfMark;
  /** Group holding the inner text. */
  group: number;
  /** Code spans are literal: delimiters inside them are not markup. */
  literal?: boolean;
}

const INLINE_PATTERNS: readonly InlinePattern[] = [
  { regex: /`([^`\n]+)`/, mark: () => ({ type: 'code' }), group: 1, literal: true },
  {
    regex: /\[([^\]\n]*)\]\(([^)\s]+)\)/,
    mark: (m) => ({ type: 'link', attrs: { href: unmaskEscapes(m[2] ?? '') } }),
    group: 1,
  },
  // The negative lookahead makes the closing delimiter the *last* of a run.
  // Without it `**bold *and italic***` closes on the first two of the trailing
  // three asterisks, capturing `bold *and italic` and leaving a stray `*`.
  // With it, backtracking finds the correct close and `***both***` also lands
  // as strong+em rather than as a literal asterisk plus bold.
  { regex: /\*\*([^\n]+?)\*\*(?!\*)/, mark: () => ({ type: 'strong' }), group: 1 },
  { regex: /__([^\n]+?)__(?!_)/, mark: () => ({ type: 'strong' }), group: 1 },
  { regex: /~~([^\n]+?)~~(?!~)/, mark: () => ({ type: 'strike' }), group: 1 },
  { regex: /\*([^*\n]+?)\*/, mark: () => ({ type: 'em' }), group: 1 },
  { regex: /(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/, mark: () => ({ type: 'em' }), group: 1 },
];

/**
 * Emits text nodes carrying the accumulated marks.
 *
 * Marks are passed down rather than wrapped, because ADF has no nesting for
 * them: bold-inside-italic is one text node with two marks, not two nodes.
 */
function parseInline(text: string, marks: readonly AdfMark[]): AdfNode[] {
  if (text === '') {
    return [];
  }

  let earliest: { pattern: InlinePattern; match: RegExpExecArray } | null = null;
  for (const pattern of INLINE_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (match && (earliest === null || match.index < earliest.match.index)) {
      earliest = { pattern, match };
    }
  }

  if (earliest === null) {
    return textNode(text, marks);
  }

  const { pattern, match } = earliest;
  const inner = match[pattern.group] ?? '';
  const innerMarks = [...marks, pattern.mark(match)];

  return [
    ...parseInline(text.slice(0, match.index), marks),
    ...(pattern.literal === true ? textNode(inner, innerMarks) : parseInline(inner, innerMarks)),
    ...parseInline(text.slice(match.index + match[0].length), marks),
  ];
}

function textNode(text: string, marks: readonly AdfMark[]): AdfNode[] {
  const restored = unmaskEscapes(text);
  // ADF rejects a text node with an empty string, so an empty run is dropped
  // rather than emitted.
  if (restored === '') {
    return [];
  }
  return [{ type: 'text', text: restored, ...(marks.length === 0 ? {} : { marks: [...marks] }) }];
}

// ---------------------------------------------------------------- mentions

/**
 * Post-process ADF nodes to convert [~accountId] patterns to mention nodes.
 *
 * Jira wiki markup uses [~accountId] for mentions.
 * Account IDs are UUIDs with a numeric prefix (e.g., 557058:xxx-xxx-xxx).
 */
function processMentions(nodes: readonly AdfNode[]): AdfNode[] {
  return nodes.flatMap((node) => {
    // Recursively process children
    if (node.content && Array.isArray(node.content)) {
      return { ...node, content: processMentions(node.content) };
    }

    // Convert text nodes containing [~mention] patterns
    if (node.type === 'text' && typeof node.text === 'string') {
      const result = processMentionsInText(node, node.marks ?? []);
      return Array.isArray(result) ? result : [result];
    }

    return node;
  });
}

/**
 * The account id inside a `[~...]`, or null when it is not one.
 *
 * Jira Cloud writes mentions three ways and this has to accept all of them:
 *
 *   [~accountid:5b21a397a6d3c211bbc5f967]   the documented wiki syntax
 *   [~5b21a397a6d3c211bbc5f967]             a bare 24-hex account id
 *   [~557058:3bce8cf9-3a60-4a2e-b655-...]   the colon form
 *
 * The previous pattern — `[0-9a-f]+:[0-9a-f-]+` — required a colon, so it
 * matched only the third. The other two passed through as literal text and
 * were posted verbatim: a comment reading "[~accountid:5b21...] please
 * look" instead of a mention, with nobody notified. It went unnoticed
 * because the only tests used the colon form.
 *
 * Validation is done here rather than in the regex because the regex that
 * expresses "any of these three but not [~username]" is unreadable, and
 * being unreadable is how it came to be wrong in the first place.
 */
function accountIdOf(raw: string): string | null {
  const value = raw.trim().replace(/^accountid:/i, '');
  // 24+ hex characters: the modern Atlassian account id.
  if (/^[0-9a-f]{24,}$/i.test(value)) return value;
  // Or a colon-separated id (557058:uuid, qm:uuid:uuid).
  if (/^[0-9a-zA-Z]+:[0-9a-zA-Z:_-]{8,}$/.test(value)) return value;
  // Anything else — [~username], [~a.name] — cannot be resolved on Cloud.
  // Emitting a mention with a bogus id renders as a broken chip that
  // notifies nobody, which is strictly worse than leaving the text alone.
  return null;
}

/**
 * Convert [~accountId] patterns in a text node to separate text and mention nodes.
 */
function processMentionsInText(node: AdfNode, marks: readonly AdfMark[]): AdfNode | AdfNode[] {
  const text = node.text ?? '';
  const mentionPattern = /\[~([^\]\s][^\]]*)\]/g;

  const parts: AdfNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const accountId = accountIdOf(match[1] ?? '');
    // Not an account id: leave it as ordinary text. lastIndex is not moved,
    // so the bracketed text is carried into the next slice rather than
    // being silently dropped.
    if (accountId === null) continue;

    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        text: text.slice(lastIndex, match.index),
        ...(marks.length === 0 ? {} : { marks: [...marks] }),
      });
    }

    parts.push({
      type: 'mention',
      attrs: {
        id: accountId,
        text: `[~${accountId}]`,
      },
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after the last mention
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      text: text.slice(lastIndex),
      ...(marks.length === 0 ? {} : { marks: [...marks] }),
    });
  }

  // If no mentions found, return original node
  if (parts.length === 0) {
    return node;
  }

  // If we created parts, return them (may be multiple nodes now)
  return parts;
}
