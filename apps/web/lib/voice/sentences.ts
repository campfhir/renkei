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
 * The first piece of a reply is the exception to "sentences are the
 * unit": until it is heard the person is waiting on silence, and a
 * model's opening sentence is often its longest. So while nothing of the
 * reply has been spoken yet and no sentence has closed, a clause is
 * enough — the text up to a comma, a colon, a semicolon or a dash, once
 * it is MIN_CHUNK_CHARS long — and the rest of the sentence follows as
 * the next piece, joined gapless (speech-queue.ts).
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
/**
 * A clause end, for a reply's first piece: a comma, colon or semicolon
 * followed by whitespace (so "1,000" is never cut), or a dash between
 * spaces.
 */
const CLAUSE_END = /[,;:]\s+|\s[—–-]\s+/g;

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
 * The first clause of `buffer` long enough to be worth saying on its own,
 * and what follows it; null when there is no such clause yet.
 */
function takeFirstClause(buffer: string): { clause: string; rest: string } | null {
  CLAUSE_END.lastIndex = 0;
  for (const match of buffer.matchAll(CLAUSE_END)) {
    const end = match.index + match[0].length;
    if (buffer.slice(0, end).trim().length < MIN_CHUNK_CHARS) continue;
    if (fenceOpen(buffer.slice(0, end))) continue;
    return { clause: buffer.slice(0, end), rest: buffer.slice(end) };
  }
  return null;
}

/**
 * The complete pieces in `buffer`, oldest first, and what remains after
 * them. With `final`, the remainder is a piece too — the turn has ended
 * and nothing more is coming. With `first`, nothing of the reply has been
 * spoken yet: if no sentence has closed, its first clause goes out alone
 * rather than waiting for the sentence's end.
 */
export function takeSpeakable(
  buffer: string,
  options: { final?: boolean; first?: boolean } = {}
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
  if (sentences.length === 0 && options.first && !options.final) {
    const opening = takeFirstClause(buffer);
    if (opening) return { chunks: [opening.clause.trim()], rest: opening.rest };
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
