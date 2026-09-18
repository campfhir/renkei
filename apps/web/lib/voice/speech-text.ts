/**
 * A reply as it should be READ, not as it is written. Replies are Markdown
 * for the eye — headings, bullets, bold, links, fenced code, tables — and
 * a voice reading the punctuation of all that aloud ("asterisk asterisk
 * pound") is worse than silence. This strips the syntax and keeps the
 * words, and says in one breath what it will not read: a code block is
 * "Code omitted", a table is read row by row.
 *
 * Pure and dependency-free: the same function runs in the browser for
 * every sentence as it streams.
 */

/** What a voice says in place of a fenced code block. */
export const CODE_OMITTED = 'Code omitted.';

function tableRowToSpeech(row: string): string | null {
  const cells = row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  // The header/body separator row: |---|:--:|
  if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) return null;
  const spoken = cells.filter(Boolean).join(', ');
  return spoken ? `${spoken}.` : null;
}

export function speakableText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, '\n');

  // Fenced code, closed or (at the end of a stream) still open.
  text = text.replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, `\n${CODE_OMITTED}\n`);
  // HTML comments and tags.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  // Images: the alt text, if any.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: the label. A bare URL becomes "link".
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/<https?:\/\/[^>]+>/g, 'link');
  text = text.replace(/https?:\/\/\S+/g, 'link');

  const lines = text.split('\n').map((line) => {
    let out = line;
    // Table rows, read as their cells.
    if (/^\s*\|.*\|\s*$/.test(out)) return tableRowToSpeech(out) ?? '';
    // Headings, block quotes, list markers, task boxes, horizontal rules.
    out = out.replace(/^\s{0,3}#{1,6}\s+/, '');
    out = out.replace(/^\s{0,3}>\s?/, '');
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(out)) return '';
    out = out.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    return out;
  });
  text = lines.join('\n');

  // Emphasis and inline code: the words inside.
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2');
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1$2');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Footnote and reference marks.
  text = text.replace(/\[\^[^\]]+\]/g, '');
  // Stray markdown escapes.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

  // A heading or list item with no closing punctuation reads as a run-on
  // into the next line; a full stop at each line end keeps them apart.
  const finished = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,…]$/.test(line) ? line : `${line}.`));
  return finished
    .join(' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
