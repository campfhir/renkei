/**
 * Structural normalization shared by every downstream stage: linearize HTML
 * into text (paragraph/line breaks only — no DOM dependency, since nothing
 * downstream needs one) and collapse whitespace deterministically.
 */

const DROPPED_ELEMENTS = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const LINE_BREAK_TAGS = /<br\s*\/?>/gi;
const BLOCK_BREAK_CLOSERS = /<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi;
const ANY_TAG = /<[^>]+>/g;

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
  const withoutDropped = html.replace(DROPPED_ELEMENTS, '');
  const withBreaks = withoutDropped
    .replace(LINE_BREAK_TAGS, '\n')
    .replace(BLOCK_BREAK_CLOSERS, '\n');
  const withoutTags = withBreaks.replace(ANY_TAG, '');
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
