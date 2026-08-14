/**
 * Splitting a chunk into headings and prose.
 *
 * THIS IS DELIBERATELY NOT A MARKDOWN PARSER. The knowledge store holds mail
 * bodies, WebEx messages, meeting transcripts and extracted documents, none of
 * which are markdown, and all of which contain characters markdown gives
 * meaning to. Someone writing "the *only* option" in an email, or a transcript
 * naming plan_v2.md, must not have that eaten by a formatter guessing at
 * intent. So exactly one construct is recognised — a line beginning with one
 * to six hashes and a space — and everything else is passed through untouched.
 *
 * A line of prose that happens to start with "#" renders slightly bolder than
 * it should. Nothing is lost and nothing is reflowed; that is the whole
 * downside.
 *
 * Kept apart from the component so it can be tested without a renderer.
 */

export interface Block {
  kind: 'heading' | 'text';
  level: number;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Split text into headings and everything between them.
 *
 * Consecutive non-heading lines stay in one block so `whitespace-pre-wrap`
 * keeps the author's own line breaks — the property that makes a transcript or
 * a field list readable.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const body = buffer.join('\n').replace(/^\n+|\n+$/g, '');
    if (body.trim()) blocks.push({ kind: 'text', level: 0, text: body });
    buffer = [];
  };

  for (const line of text.split('\n')) {
    const match = HEADING.exec(line);
    if (match?.[1] && match[2]?.trim()) {
      flush();
      blocks.push({ kind: 'heading', level: match[1].length, text: match[2].trim() });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * Drop a leading heading that just restates the card's title.
 *
 * The card already shows "SUP-4821: Login fails after SSO migration"; opening
 * the body with "Login fails after SSO migration" again is the duplication
 * that made these cards useless in the first place. Only the FIRST block is
 * considered, and only when it is contained in the title — a later heading
 * that happens to match is real content.
 */
export function withoutEchoedTitle(blocks: Block[], title: string): Block[] {
  const first = blocks[0];
  if (!first || first.kind !== 'heading') return blocks;
  const normalise = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const heading = normalise(first.text);
  if (!heading) return blocks;
  return normalise(title).includes(heading) ? blocks.slice(1) : blocks;
}
