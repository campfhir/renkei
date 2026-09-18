/**
 * Finding a chat by what was said in it, not only by its title.
 *
 * Message content is sealed at rest (092-chat: one `renc1` envelope per
 * row), so SQL cannot match it — the search opens rows server-side and
 * scans the text. That is bounded three ways: only the chats the viewer
 * already sees in the sidebar are read; only prompts and replies are
 * opened (tool results are the bulk of a chat and nobody remembers a
 * chat by its JSON); and the scan walks newest chat first in pages,
 * stopping at a hit ceiling or a row ceiling, whichever comes first, so a
 * common word over a long history costs a few pages, not the table.
 *
 * A hit names the chat and carries a short window of text around the
 * first match, for the sidebar to show under the title.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { openBlocks } from './content-crypto';
import {
  CHAT_SEARCH_MAX_HITS,
  CHAT_SEARCH_MAX_ROWS,
  CHAT_SEARCH_MIN_CHARS,
  normalizeQuery,
  searchableText,
  snippetAround,
  type ChatSearchHit,
} from './search-text';

export type { ChatSearchHit } from './search-text';
export {
  CHAT_SEARCH_MAX_CHARS,
  CHAT_SEARCH_MAX_HITS,
  CHAT_SEARCH_MAX_ROWS,
  CHAT_SEARCH_MIN_CHARS,
  normalizeQuery,
  searchableText,
  snippetAround,
} from './search-text';

/** Rows fetched per round trip while scanning. */
const PAGE_SIZE = 500;

/**
 * The chats among `chatIds` whose prompts or replies contain `query`,
 * newest chat first, one hit each. `chatIds` is the caller's statement
 * of what the viewer may read — pass the sidebar's list, nothing wider.
 */
export async function searchChatMessages(
  db: Kysely<DB>,
  tenantId: string,
  chatIds: string[],
  query: string
): Promise<ChatSearchHit[]> {
  const needle = normalizeQuery(query);
  const ids = chatIds.filter(isUuid);
  if (needle.length < CHAT_SEARCH_MIN_CHARS || ids.length === 0) return [];

  const hits = new Map<string, ChatSearchHit>();
  let offset = 0;
  while (hits.size < CHAT_SEARCH_MAX_HITS && offset < CHAT_SEARCH_MAX_ROWS) {
    const rows = await db
      .selectFrom('chat_messages')
      .innerJoin('chats', 'chats.id', 'chat_messages.chat_id')
      .select([
        'chat_messages.id as id',
        'chat_messages.chat_id as chat_id',
        'chat_messages.content as content',
      ])
      .where('chat_messages.tenant_id', '=', tenantId)
      .where('chat_messages.chat_id', 'in', ids)
      .where('chat_messages.kind', 'in', ['prompt', 'assistant'])
      .orderBy('chats.updated_at', 'desc')
      .orderBy('chat_messages.seq', 'desc')
      .limit(Math.min(PAGE_SIZE, CHAT_SEARCH_MAX_ROWS - offset))
      .offset(offset)
      .execute();
    for (const row of rows) {
      // Newest message first within a chat: the first match is the one kept.
      if (hits.has(row.chat_id)) continue;
      const snippet = snippetAround(searchableText(openBlocks(row.content)), needle);
      if (snippet === null) continue;
      hits.set(row.chat_id, { chatId: row.chat_id, messageId: row.id, snippet });
      if (hits.size >= CHAT_SEARCH_MAX_HITS) break;
    }
    if (rows.length < PAGE_SIZE) break;
    offset += rows.length;
  }
  return [...hits.values()];
}
