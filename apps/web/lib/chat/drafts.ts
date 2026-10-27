/**
 * The composer's unsent text, kept server-side (`chat_drafts`) so a reload,
 * another tab or another device finds it where it was left. Sealed under
 * the chat's key like the messages it may become. No row means no draft:
 * saving an empty string deletes it.
 */

import { getDataStore } from '@renkei/db';
import type { ContentCipher } from './content-crypto';

/** The queue's cap on one message (queued-sends.ts): a draft is a message in waiting. */
export const MAX_DRAFT_CHARS = 200_000;

const UNAVAILABLE_PREFIX = '[content unavailable';

/** The saved draft, or '' when there is none or this session cannot open it. */
export async function loadDraft(chatId: string, cipher: ContentCipher): Promise<string> {
  if (cipher.unavailable) return '';
  const content = await getDataStore().chatThreads.getDraft(chatId);
  if (content === null) return '';
  const text = cipher.open(content);
  // A draft sealed under a key this session cannot open is not worth a marker in the box.
  return text.startsWith(UNAVAILABLE_PREFIX) ? '' : text;
}

/** Replace the chat's draft with `text`; false when it could not be sealed. */
export async function saveDraft(
  chatId: string,
  text: string,
  cipher: ContentCipher
): Promise<boolean> {
  if (text.trim().length === 0) {
    await getDataStore().chatThreads.deleteDraft(chatId);
    return true;
  }
  const sealed = cipher.seal(text);
  if (!sealed.ok) return false;
  await getDataStore().chatThreads.saveDraft(chatId, sealed.val);
  return true;
}
