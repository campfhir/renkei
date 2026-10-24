/**
 * The composer's unsent text, kept server-side (`chat_drafts`) so a reload,
 * another tab or another device finds it where it was left. Sealed under
 * the chat's key like the messages it may become. No row means no draft:
 * saving an empty string deletes it.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ContentCipher } from './content-crypto';

/** The queue's cap on one message (queued-sends.ts): a draft is a message in waiting. */
export const MAX_DRAFT_CHARS = 200_000;

const UNAVAILABLE_PREFIX = '[content unavailable';

/** The saved draft, or '' when there is none or this session cannot open it. */
export async function loadDraft(
  db: Kysely<DB>,
  chatId: string,
  cipher: ContentCipher
): Promise<string> {
  if (cipher.unavailable) return '';
  const row = await db
    .selectFrom('chat_drafts')
    .select('content')
    .where('chat_id', '=', chatId)
    .executeTakeFirst();
  if (!row) return '';
  const text = cipher.open(row.content);
  // A draft sealed under a key this session cannot open is not worth a marker in the box.
  return text.startsWith(UNAVAILABLE_PREFIX) ? '' : text;
}

/** Replace the chat's draft with `text`; false when it could not be sealed. */
export async function saveDraft(
  db: Kysely<DB>,
  chatId: string,
  text: string,
  cipher: ContentCipher
): Promise<boolean> {
  if (text.trim().length === 0) {
    await db.deleteFrom('chat_drafts').where('chat_id', '=', chatId).execute();
    return true;
  }
  const sealed = cipher.seal(text);
  if (!sealed.ok) return false;
  await db
    .insertInto('chat_drafts')
    .values({ chat_id: chatId, content: sealed.val })
    .onConflict((oc) =>
      oc.column('chat_id').doUpdateSet({ content: sealed.val, updated_at: new Date() })
    )
    .execute();
  return true;
}
