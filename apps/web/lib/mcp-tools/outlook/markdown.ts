/**
 * Markdown → HTML for outgoing email.
 *
 * The model writes Markdown far more reliably than it writes HTML, and
 * Outlook renders HTML far more reliably than it renders Markdown — so
 * every composed body, reply comment and forward note is Markdown on the
 * way in and HTML on the way out. Paragraphs, **bold**, *italic*, bullet
 * and numbered lists, links: the formatting a work email actually uses.
 *
 * Two things marked does NOT do on its own that an email needs: raw HTML
 * in the source is escaped rather than passed through (the model has no
 * business hand-writing tags, and a stray `<` in prose must not vanish),
 * and a link only becomes an anchor when its target is http(s) or mailto.
 * The output also feeds the preview card's innerHTML, which is why both
 * guards live here and not in the card.
 */

import { Marked, type Tokens } from 'marked';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SAFE_HREF = /^(https?:|mailto:)/i;

const renderer = new Marked({
  gfm: true,
  // A single newline is a line break, as anyone typing into an email
  // client expects; a blank line is still a paragraph break.
  breaks: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, token: Tokens.Link) {
      // The default rendering is fine for a safe target; anything else
      // (javascript:, data:, a bare relative path) keeps its text only.
      return SAFE_HREF.test(token.href.trim()) ? false : this.parser.parseInline(token.tokens);
    },
    image({ text }: Tokens.Image) {
      return escapeHtml(text);
    },
  },
});

/** The HTML body for `markdown`, wrapped in one block so it can be prepended as a unit. */
export function markdownToHtml(markdown: string): string {
  const html = renderer.parse(markdown.replace(/\r\n?/g, '\n'));
  if (typeof html !== 'string') throw new Error('markdown rendered asynchronously');
  return `<div>${html.trim()}</div>`;
}
