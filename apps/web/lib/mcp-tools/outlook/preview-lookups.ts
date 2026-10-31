/**
 * The names behind the ids an Outlook mailbox act's preview card carries (see
 * ../lookup.ts): a message's subject, a mail folder's name. Reads only; a
 * failure leaves the name out and the card says "a message", never the id.
 */

import type { MCPToolContext } from '../common';
import type { GraphAuth } from '../graph/graph-auth';
import { enc, withReader, type GraphReader } from '../graph/preview-lookups';
import { registerPreviewLookups } from '../lookup';
import { nameKey, strings, text, type Names } from '../previews/card';

/** How many message subjects a bulk card names before saying "and N more". */
export const BULK_NAMED = 3;

async function messageName(read: GraphReader, messageId: unknown): Promise<Names> {
  const id = text(messageId);
  if (!id) return {};
  const found = await read.get(`/me/messages/${enc(id)}?$select=subject`);
  const subject = text(found?.subject);
  return subject ? { [nameKey('message', id)]: subject } : {};
}

async function folderName(read: GraphReader, folderId: unknown): Promise<Names> {
  const id = text(folderId);
  if (!id) return {};
  const found = await read.get(`/me/mailFolders/${enc(id)}?$select=displayName`);
  const name = text(found?.displayName);
  return name ? { [nameKey('folder', id)]: name } : {};
}

export function registerOutlookPreviewLookups(context: MCPToolContext, auth: GraphAuth): void {
  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  const message = withReader(context, auth, (read, args) => messageName(read, args.messageId));

  registerPreviewLookups(context, {
    outlook_mark_message: message,
    outlook_flag_message: message,
    outlook_categorize_message: message,
    outlook_move_message: withReader(context, auth, (read, args) =>
      merge(messageName(read, args.messageId), folderName(read, args.destinationFolder))
    ),
    outlook_create_mail_folder: withReader(context, auth, (read, args) =>
      folderName(read, args.parentFolderId)
    ),
    outlook_rename_mail_folder: withReader(context, auth, (read, args) =>
      folderName(read, args.folderId)
    ),
    outlook_delete_mail_folder: withReader(context, auth, (read, args) =>
      folderName(read, args.folderId)
    ),
    outlook_start_bulk_mail_job: withReader(context, auth, (read, args) => {
      const filters = typeof args.filters === 'object' && args.filters !== null ? args.filters : {};
      const folder = 'folder' in filters ? filters.folder : undefined;
      return merge(
        folderName(read, args.destinationFolder),
        folderName(read, folder),
        ...strings(args.messageIds)
          .slice(0, BULK_NAMED)
          .map((id) => messageName(read, id))
      );
    }),
  });
}
