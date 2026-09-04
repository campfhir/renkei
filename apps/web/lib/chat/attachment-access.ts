/**
 * Who may read a chat attachment: anyone who may read the chat it is in,
 * or any member of the project it belongs to. Shared by the download and
 * copy routes so the two cannot disagree.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveChatAccess, resolveResourceAccess } from './access';
import type { AttachmentRow } from './attachments';

export async function mayReadAttachment(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  row: AttachmentRow
): Promise<boolean> {
  if (row.chatId) return (await resolveChatAccess(db, tenantId, subject, row.chatId)) !== null;
  if (row.projectId) {
    return (
      (await resolveResourceAccess(db, tenantId, subject, 'chat_project', row.projectId)) !== null
    );
  }
  return false;
}
