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
 * Not supported, by choice: tables, panels, media, mentions, and status
 * lozenges. Each needs instance-specific IDs (account IDs, file references,
 * colour tokens) that a model would have to invent, and an invented mention
 * notifies a real person.
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
const ESCAPABLE = '\\`*_~[]()#-+>';
const PRIVATE_USE_BASE = 0xe000;

/** Derived from ESCAPABLE so the two cannot drift apart. */
const MASKED = new RegExp(
  `[\\u${PRIVATE_USE_BASE.toString(16)}-\\u${(PRIVATE_USE_BASE + ESCAPABLE.length - 1).toString(16)}]`,
  'g',
);

const FENCE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = maskEscapes(markdown).replace(/\r\n?/g, '\n').split('\n');
  return { version: 1, type: 'doc', content: parseBlocks(lines) };
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
      if (next.trim() === '' || startsBlock(next)) break;
      body.push(next.trim());
      i += 1;
    }
    nodes.push({ type: 'paragraph', content: parseInline(body.join(' '), []) });
  }

  return nodes;
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
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
 */
function parseList(lines: readonly string[]): AdfNode {
  const first = LIST_ITEM.exec(lines[0] ?? '');
  const baseIndent = (first?.[1] ?? '').length;
  const ordered = first?.[3] !== undefined;

  const items: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i] ?? '');
    if (!match) {
      i += 1;
      continue;
    }

    const content: AdfNode[] = [{ type: 'paragraph', content: parseInline(match[4] ?? '', []) }];
    i += 1;

    const nested: string[] = [];
    while (i < lines.length) {
      const ahead = LIST_ITEM.exec(lines[i] ?? '');
      if (!ahead || (ahead[1] ?? '').length <= baseIndent) break;
      nested.push(lines[i] ?? '');
      i += 1;
    }
    if (nested.length > 0) {
      content.push(parseList(nested));
    }

    items.push({ type: 'listItem', content });
  }

  return { type: ordered ? 'orderedList' : 'bulletList', content: items };
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
