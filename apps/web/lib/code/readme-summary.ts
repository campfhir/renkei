/**
 * A one-paragraph description of a repository, taken from its README:
 * the first stretch of plain prose, past the title, badges, images, raw
 * HTML, code and tables. Pure; the caller reads the README.
 */

export const DESCRIPTION_MAX_CHARS = 300;

const plain = (line: string): string =>
  line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The README's opening prose, at most DESCRIPTION_MAX_CHARS, or null when it has none. */
export function summarizeReadme(text: string): string | null {
  const paragraphs: string[][] = [[]];
  let fenced = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const skip =
      /^#{1,6}\s/.test(line) ||
      /^(=+|-+)$/.test(line) ||
      /^[|>]/.test(line) ||
      /^<[^>]+>$/.test(line) ||
      /^(\[!\[|!\[|\[[^\]]+\]:\s)/.test(line);
    if (line === '' || skip) {
      if (paragraphs[paragraphs.length - 1]!.length > 0) paragraphs.push([]);
      continue;
    }
    paragraphs[paragraphs.length - 1]!.push(line);
  }
  for (const lines of paragraphs) {
    const prose = plain(lines.join(' '));
    if (prose.length < 12 || !/[a-z]/i.test(prose)) continue;
    if (prose.length <= DESCRIPTION_MAX_CHARS) return prose;
    const cut = prose.slice(0, DESCRIPTION_MAX_CHARS - 1);
    const sentence = cut.search(/[.!?][^.!?]*$/);
    return sentence > 80 ? cut.slice(0, sentence + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
  }
  return null;
}
