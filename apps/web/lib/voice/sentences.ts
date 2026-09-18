/**
 * Cutting a reply into things worth saying as it streams. A voice that
 * waits for the whole reply is a voice that arrives twenty seconds late;
 * one that speaks every token is unintelligible. Sentences are the unit:
 * each complete one is handed to the synthesiser the moment it closes,
 * the next plays while the one after is fetched, and the tail that has
 * not closed yet waits for more text (or for the turn to end).
 *
 * Two guards against the vendor's per-request cost: very short sentences
 * ride together with their neighbour, and a very long one is split at a
 * space so no single request exceeds the route's cap.
 *
 * Works on the raw Markdown so a fenced block is never cut mid-way (an
 * open fence holds everything after it until it closes); `speakableText`
 * then turns each cut into words.
 */

/** Below this, a sentence waits for the next one before being spoken. */
export const MIN_CHUNK_CHARS = 40;
/** Above this, the accumulated sentences are spoken as they are. */
export const TARGET_CHUNK_CHARS = 400;
/** Never more than this in one request; the speech route caps at 3000. */
export const MAX_CHUNK_CHARS = 2_000;

/** A sentence end: terminal punctuation (with closers), then whitespace or a newline. */
const SENTENCE_END = /[.!?…]["'”’)\]]*(?:\s+|$)|\n\s*\n/g;

function fenceOpen(text: string): boolean {
  const fences = text.match(/^\s{0,3}```/gm);
  return fences !== null && fences.length % 2 === 1;
}

/** A too-long piece, split at spaces into pieces under the cap. */
function hardSplit(piece: string): string[] {
  const out: string[] = [];
  let rest = piece;
  while (rest.length > MAX_CHUNK_CHARS) {
    const cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS);
    const at = cut > MAX_CHUNK_CHARS / 2 ? cut : MAX_CHUNK_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The complete pieces in `buffer`, oldest first, and what remains after
 * them. With `final`, the remainder is a piece too — the turn has ended
 * and nothing more is coming.
 */
export function takeSpeakable(
  buffer: string,
  options: { final?: boolean } = {}
): { chunks: string[]; rest: string } {
  const sentences: string[] = [];
  let consumed = 0;
  // Inside an open fence nothing is complete until it closes.
  if (!options.final && fenceOpen(buffer)) return { chunks: [], rest: buffer };
  SENTENCE_END.lastIndex = 0;
  for (const match of buffer.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const sentence = buffer.slice(consumed, end);
    // A boundary inside a fenced block is not a boundary.
    if (fenceOpen(buffer.slice(0, end))) continue;
    if (sentence.trim()) sentences.push(sentence);
    consumed = end;
  }
  let rest = buffer.slice(consumed);
  if (options.final && rest.trim()) {
    sentences.push(rest);
    rest = '';
  }

  // Merge the short with the next; cut the long.
  const chunks: string[] = [];
  let pending = '';
  for (const sentence of sentences) {
    pending += sentence;
    if (pending.trim().length >= MIN_CHUNK_CHARS || pending.length >= TARGET_CHUNK_CHARS) {
      chunks.push(...hardSplit(pending.trim()));
      pending = '';
    }
  }
  if (pending.trim()) {
    if (options.final || chunks.length === 0) {
      // Nothing to merge it with yet: with more text still coming, it
      // waits; at the end it is spoken as it is.
      if (options.final) chunks.push(...hardSplit(pending.trim()));
      else rest = pending + rest;
    } else {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${pending.trim()}`;
    }
  }
  return { chunks, rest };
}
