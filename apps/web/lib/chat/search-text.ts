/**
 * The text side of chat search, kept free of server imports so the
 * sidebar (a client component) can share the query rules and the
 * search route can share the snippet cut. search.ts does the reading.
 */

import type { LlmContentBlock } from '@renkei/agent-llm';

export interface ChatSearchHit {
  chatId: string;
  /** The message the snippet comes from — the newest one matching. */
  messageId: string;
  /** Text around the first match, ellipsised at whichever ends were cut. */
  snippet: string;
}

/** Shorter than this and the scan is all noise: every chat matches "a". */
export const CHAT_SEARCH_MIN_CHARS = 2;
export const CHAT_SEARCH_MAX_CHARS = 200;
/** Distinct chats returned, at most. */
export const CHAT_SEARCH_MAX_HITS = 30;
/** Rows opened per query, at most, however few hits that yields. */
export const CHAT_SEARCH_MAX_ROWS = 4000;
/** Characters of context kept on each side of the match. */
const SNIPPET_CONTEXT = 60;

/**
 * The searchable text of a message: its text blocks, joined. Thinking,
 * tool calls and tool results are left out — what a person remembers
 * saying or reading is the prose, and the model's scratch work would only
 * make every chat match its own vocabulary.
 */
export function searchableText(blocks: LlmContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** The query as it is matched: trimmed, case-folded, whitespace collapsed. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, CHAT_SEARCH_MAX_CHARS);
}

/**
 * A window of `text` around the first case-insensitive occurrence of
 * `needle`, whitespace collapsed to one line, ellipsised where cut. Null
 * when the text does not contain it.
 */
export function snippetAround(text: string, needle: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const query = normalizeQuery(needle);
  if (!query) return null;
  const at = flat.toLowerCase().indexOf(query);
  if (at === -1) return null;
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, at + query.length + SNIPPET_CONTEXT);
  const match = flat.slice(at, at + query.length);
  // Context on either side, cut back to a word edge where a cut was made.
  let lead = flat.slice(start, at);
  if (start > 0) {
    const space = lead.indexOf(' ');
    if (space !== -1) lead = lead.slice(space + 1);
    lead = `…${lead}`;
  }
  let tail = flat.slice(at + query.length, end);
  if (end < flat.length) {
    const space = tail.lastIndexOf(' ');
    if (space !== -1) tail = tail.slice(0, space);
    tail = `${tail}…`;
  }
  return `${lead}${match}${tail}`.trim();
}
