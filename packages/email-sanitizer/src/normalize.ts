/**
 * Structural normalization shared by every downstream stage: linearize HTML
 * into text (paragraph/line breaks only — no DOM dependency, since nothing
 * downstream needs one) and collapse whitespace deterministically.
 */

const LINE_BREAK_TAGS = /<br\s*\/?>/gi;
const BLOCK_BREAK_CLOSERS = /<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi;

/**
 * Drop `<script>…</script>` and `<style>…</style>` wholesale, as the regex
 * `<(script|style)[^>]*>[\s\S]*?<\/\1>` did — by scanning, because that
 * regex rescans to the end of the body from every unterminated opener, and
 * the body is whatever a sender wrote. An element with no closer stays, as
 * it did before (the tag stripper then takes its tags).
 */
function dropElements(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let cursor = 0;
  // Each opener's next position is looked up only once it is behind the
  // cursor, so a body of nothing but openers is one pass, not one per opener.
  let script = lower.indexOf('<script');
  let style = lower.indexOf('<style');
  for (;;) {
    if (script !== -1 && script < cursor) script = lower.indexOf('<script', cursor);
    if (style !== -1 && style < cursor) style = lower.indexOf('<style', cursor);
    if (script === -1 && style === -1) break;
    const start = script === -1 ? style : style === -1 ? script : Math.min(script, style);
    const name = start === script ? 'script' : 'style';
    const openerEnd = lower.indexOf('>', start);
    const close = openerEnd === -1 ? -1 : lower.indexOf(`</${name}>`, openerEnd + 1);
    if (close === -1) {
      // No closer: not an element, just text that begins with `<`.
      out += html.slice(cursor, start + 1);
      cursor = start + 1;
      continue;
    }
    out += html.slice(cursor, start);
    cursor = close + name.length + 3;
  }
  return out + html.slice(cursor);
}

/**
 * Remove every `<…>` tag (replacing it with `replacement`), as `/<[^>]+>/g`
 * did — by scanning, because that regex rescans to the end from every `<`
 * that never closes. `<>` and an unclosed `<` stay, as they did before.
 */
export function stripTags(text: string, replacement = ''): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('<', cursor);
    if (open === -1) break;
    const close = text.indexOf('>', open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      out += text.slice(cursor, close + 1);
    } else {
      out += text.slice(cursor, open) + replacement;
    }
    cursor = close + 1;
  }
  return out + text.slice(cursor);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1]?.toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    const replacement = NAMED_ENTITIES[entity.toLowerCase()];
    return replacement ?? match;
  });
}

/** Linearize an HTML email body into plain text, preserving line structure only. */
export function htmlToText(html: string): string {
  const withoutDropped = dropElements(html);
  const withBreaks = withoutDropped
    .replace(LINE_BREAK_TAGS, '\n')
    .replace(BLOCK_BREAK_CLOSERS, '\n');
  const withoutTags = stripTags(withBreaks);
  return decodeEntities(withoutTags);
}

/** Collapse runs of horizontal whitespace and blank lines without disturbing paragraph structure. */
export function collapseWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeBody(body: { content: string; contentType: 'html' | 'text' }): string {
  const linearized = body.contentType === 'html' ? htmlToText(body.content) : body.content;
  return collapseWhitespace(linearized.normalize('NFKC'));
}
