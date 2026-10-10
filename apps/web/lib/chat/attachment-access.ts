/**
 * Who may read a chat attachment: anyone who may read the chat it is in,
 * or any member of the project it belongs to. Shared by the download and
 * copy routes so the two cannot disagree.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveChatAccess, resolveProjectAccess } from './access';
import type { ContentCipher } from './content-crypto';

export async function mayReadAttachment(
  db: Kysely<DB>,
  subject: string,
  row: { chatId: string | null; projectId: string | null }
): Promise<boolean> {
  return (await attachmentCipherFor(db, subject, row)) !== null;
}

/**
 * The cipher this reader opens the file's text with — the chat's or the
 * project's, by where the file lives — or null when they may not read it.
 */
export async function attachmentCipherFor(
  db: Kysely<DB>,
  subject: string,
  row: { chatId: string | null; projectId: string | null }
): Promise<ContentCipher | null> {
  if (row.chatId) {
    const access = await resolveChatAccess(db, subject, row.chatId);
    return access?.cipher ?? null;
  }
  if (row.projectId) {
    const access = await resolveProjectAccess(db, subject, row.projectId);
    return access?.cipher ?? null;
  }
  return null;
}
