/**
 * Jira wiki markup → Markdown.
 *
 * REST v3 returns rich text as ADF. REST v2 — and Cloud responses on instances
 * still speaking it — returns wiki markup, which is a DIFFERENT LANGUAGE that
 * happens to share characters with Markdown, and disagrees about the most
 * important one:
 *
 *   wiki        markdown        meaning
 *   # item      1. item         ordered list item
 *   * item      - item          bullet
 *   h2. Title   ## Title        heading
 *   {{code}}    `code`          monospace
 *
 * `#` is the trap. Passing wiki text through as Markdown turns every step of a
 * numbered backout plan into a heading — and, once those get demoted to nest
 * under their section, into a heading of the wrong depth as well. A real change
 * ticket's rollback procedure came back as four `####` lines with no order to
 * them.
 *
 * This converts the constructs that change MEANING, not the ones that only
 * change appearance. Bold and italic are left alone: wiki `*bold*` renders as
 * italic in Markdown, which is wrong but harmless, whereas guessing at emphasis
 * risks mangling text like `*Security Review:*` or a bare asterisk in prose.
 */

/** Depth of a wiki list marker: `##` is a second-level ordered item. */
const ORDERED = /^(#{1,6})\s+(.*)$/;
const BULLETED = /^(\*{1,6})\s+(.*)$/;
const HEADING = /^h([1-6])\.\s+(.*)$/i;
/** ``{{monospace}}`` — the one inline form worth converting, since it is
 * frequently a command or an env var and backticks keep it intact. */
const MONOSPACE = /\{\{([^{}]+)\}\}/g;
/** `{code}` / `{noformat}` blocks delimit literal text. */
const CODE_FENCE = /^\{(code|noformat)(?::[^}]*)?\}$/i;

/**
 * True when text looks like wiki markup rather than Markdown.
 *
 * Only used to decide whether conversion is worth attempting; converting
 * ordinary prose is a no-op either way, since none of the rules fire without
 * their markers at the start of a line.
 */
export function looksLikeWikiMarkup(text: string): boolean {
  return (
    /^h[1-6]\.\s/m.test(text) || /\{\{[^{}]+\}\}/.test(text) || /^\{(code|noformat)/im.test(text)
  );
}

export function wikiToMarkdown(text: string): string {
  if (!text) return '';

  let inCode = false;
  const lines = text.split('\n').map((line) => {
    const fence = CODE_FENCE.exec(line.trim());
    if (fence) {
      inCode = !inCode;
      return '```';
    }
    // Inside a code block everything is literal, including a leading `#`.
    if (inCode) return line;

    const headingMatch = HEADING.exec(line);
    if (headingMatch?.[1] && headingMatch[2] !== undefined) {
      return `${'#'.repeat(Number(headingMatch[1]))} ${headingMatch[2]}`;
    }

    const ordered = ORDERED.exec(line);
    if (ordered?.[1] && ordered[2] !== undefined) {
      // Nested depth becomes indentation; every item is `1.` because Markdown
      // renumbers, and the source carries no numbers of its own.
      return `${'   '.repeat(ordered[1].length - 1)}1. ${ordered[2]}`;
    }

    const bulleted = BULLETED.exec(line);
    if (bulleted?.[1] && bulleted[2] !== undefined) {
      return `${'  '.repeat(bulleted[1].length - 1)}- ${bulleted[2]}`;
    }

    return line;
  });

  return lines.join('\n').replace(MONOSPACE, '`$1`').trim();
}
