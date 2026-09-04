/**
 * Markdown → a small block model every renderer shares. The model writes
 * Markdown far more reliably than it writes any document format, so a
 * Word document, a PDF and a slide deck all start here: headings,
 * paragraphs, lists (nested), fenced code, tables, quotes and rules, with
 * bold / italic / code / strikethrough / link runs inside them. Raw HTML
 * is kept as its text — the model has no business hand-writing tags into
 * a document — and images are reduced to their alt text, since no
 * renderer here fetches anything.
 *
 * marked's lexer HTML-escapes text and code spans (its renderer is what
 * would emit them into HTML); every renderer here writes plain text, so
 * the entities are undone once, on the way into the model.
 */

import { Marked, type MarkedToken, type Token, type Tokens } from 'marked';

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** An http(s) or mailto target; anything else stays plain text. */
  href?: string;
}

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  inlines: Inline[];
  /** Nested lists and any other blocks under the item. */
  children: Block[];
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; text: string; lang: string | null }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'rule' };

const SAFE_HREF = /^(https?:|mailto:)/i;

const lexer = new Marked({ gfm: true, async: false });

/** Narrows marked's loose `Token` (which admits its Generic shape) to one kind. */
function is<K extends MarkedToken['type']>(
  token: Token,
  type: K
): token is Extract<MarkedToken, { type: K }> {
  return token.type === type;
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

type Style = Pick<Inline, 'bold' | 'italic' | 'code' | 'strike' | 'href'>;

function withStyle(text: string, style: Style): Inline {
  const inline: Inline = { text };
  if (style.bold) inline.bold = true;
  if (style.italic) inline.italic = true;
  if (style.code) inline.code = true;
  if (style.strike) inline.strike = true;
  if (style.href) inline.href = style.href;
  return inline;
}

function childTokens(token: Token): Token[] | undefined {
  return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : undefined;
}

function ownText(token: Token): string | undefined {
  return 'text' in token && typeof token.text === 'string' ? token.text : undefined;
}

function inlinesOf(tokens: Token[] | undefined, style: Style, out: Inline[]): Inline[] {
  for (const token of tokens ?? []) {
    if (is(token, 'text')) {
      if (token.tokens && token.tokens.length > 0) inlinesOf(token.tokens, style, out);
      else out.push(withStyle(unescapeHtml(token.text), style));
    } else if (is(token, 'escape')) {
      out.push(withStyle(unescapeHtml(token.text), style));
    } else if (is(token, 'strong')) {
      inlinesOf(token.tokens, { ...style, bold: true }, out);
    } else if (is(token, 'em')) {
      inlinesOf(token.tokens, { ...style, italic: true }, out);
    } else if (is(token, 'del')) {
      inlinesOf(token.tokens, { ...style, strike: true }, out);
    } else if (is(token, 'codespan')) {
      out.push(withStyle(unescapeHtml(token.text), { ...style, code: true }));
    } else if (is(token, 'link')) {
      const href = token.href.trim();
      inlinesOf(token.tokens, SAFE_HREF.test(href) ? { ...style, href } : style, out);
    } else if (is(token, 'image')) {
      out.push(withStyle(token.text, style));
    } else if (is(token, 'br')) {
      out.push(withStyle('\n', style));
    } else if (is(token, 'html')) {
      out.push(withStyle(token.text, style));
    } else {
      const children = childTokens(token);
      const text = ownText(token);
      if (children) inlinesOf(children, style, out);
      else if (text !== undefined) out.push(withStyle(unescapeHtml(text), style));
    }
  }
  return out;
}

function mergeRuns(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    if (inline.text === '') continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === inline.bold &&
      last.italic === inline.italic &&
      last.code === inline.code &&
      last.strike === inline.strike &&
      last.href === inline.href
    ) {
      last.text += inline.text;
    } else {
      out.push({ ...inline });
    }
  }
  return out;
}

export function inlines(tokens: Token[] | undefined): Inline[] {
  return mergeRuns(inlinesOf(tokens, {}, []));
}

function lineBreak(): Tokens.Br {
  return { type: 'br', raw: '\n' };
}

function listItem(item: Tokens.ListItem): ListItem {
  const textTokens: Token[] = [];
  const children: Block[] = [];
  for (const token of item.tokens) {
    if (is(token, 'text') || is(token, 'paragraph')) {
      if (textTokens.length > 0) textTokens.push(lineBreak());
      textTokens.push(...(token.tokens ?? []));
    } else if (is(token, 'space')) {
      continue;
    } else {
      children.push(...blocksOf([token]));
    }
  }
  return { inlines: inlines(textTokens), children };
}

function headingLevel(depth: number): 1 | 2 | 3 | 4 | 5 | 6 {
  switch (depth) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      return depth < 1 ? 1 : 6;
  }
}

function paragraphOf(runs: Inline[], out: Block[]): void {
  if (runs.some((run) => run.text.trim())) out.push({ type: 'paragraph', inlines: runs });
}

function blocksOf(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const token of tokens) {
    if (is(token, 'heading')) {
      out.push({
        type: 'heading',
        level: headingLevel(token.depth),
        inlines: inlines(token.tokens),
      });
    } else if (is(token, 'paragraph')) {
      out.push({ type: 'paragraph', inlines: inlines(token.tokens) });
    } else if (is(token, 'text')) {
      // Top-level loose text (marked's fallback outside a paragraph).
      paragraphOf(token.tokens ? inlines(token.tokens) : [{ text: unescapeHtml(token.text) }], out);
    } else if (is(token, 'list')) {
      out.push({
        type: 'list',
        ordered: token.ordered,
        start: typeof token.start === 'number' ? token.start : 1,
        items: token.items.map(listItem),
      });
    } else if (is(token, 'code')) {
      out.push({ type: 'code', text: token.text, lang: token.lang?.trim() || null });
    } else if (is(token, 'table')) {
      out.push({
        type: 'table',
        header: token.header.map((cell) => inlines(cell.tokens)),
        rows: token.rows.map((row) => row.map((cell) => inlines(cell.tokens))),
        align: token.align.map((align) => align ?? null),
      });
    } else if (is(token, 'blockquote')) {
      out.push({ type: 'quote', blocks: blocksOf(token.tokens) });
    } else if (is(token, 'hr')) {
      out.push({ type: 'rule' });
    } else if (is(token, 'html')) {
      const text = token.text.trim();
      if (text) out.push({ type: 'paragraph', inlines: [{ text }] });
    } else if (is(token, 'space')) {
      continue;
    } else {
      const children = childTokens(token);
      if (children) paragraphOf(inlines(children), out);
    }
  }
  return out;
}

/** The blocks of a Markdown document, line endings normalized. */
export function parseMarkdown(markdown: string): Block[] {
  return blocksOf(lexer.lexer(markdown.replace(/\r\n?/g, '\n')));
}

export function plainText(runs: Inline[]): string {
  return runs.map((run) => run.text).join('');
}

/** The text of the first heading, for a title when the caller has none. */
export function firstHeading(blocks: Block[]): string | null {
  for (const block of blocks) {
    if (block.type === 'heading') {
      const text = plainText(block.inlines).trim();
      if (text) return text;
    }
  }
  return null;
}
