/**
 * chat_read_attachment — the model's eyes on the files a person uploaded:
 * reading pages through the text extracted at upload (so a document is
 * legible on any provider). It checks that the attachment belongs to this
 * chat or its project — an id from elsewhere is "not found". Staging a
 * file's bytes into the sandbox, and bringing a staged file back, is
 * sandbox-file-tools.ts (chat_attach_to_sandbox, chat_attach_from_sandbox),
 * which looks files up the same way.
 */

import { openText, type ContentCipher } from './content-crypto';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from './local-tools';
import { getAttachment } from './attachments';
import { fileCipherFor } from './artifact-access';

const READ_DEFAULT_CHARS = 20_000;
const READ_MAX_CHARS = 80_000;

export interface FoundAttachment {
  id: string;
  filename: string;
  contentType: string;
  blobKey: string;
  extractedText: string | null;
  extractStatus: string;
  /** What opens its text and its bytes; null when no key reaches it. */
  cipher: ContentCipher | null;
}

/** One of this chat's or its project's files by id, its text opened under the right key; null for any other id. */
export async function findAttachment(
  context: LocalToolContext,
  attachmentId: string
): Promise<FoundAttachment | null> {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return null;
  const row = await getAttachment(attachmentId);
  if (!row) return null;
  // The chat's own file, or one its project holds; anything else is "not found".
  if (row.chatId !== context.chatId) {
    if (!context.projectId) return null;
    const held = await context.db
      .selectFrom('artifact_references')
      .select('id')
      .where('artifact_id', '=', row.id)
      .where('project_id', '=', context.projectId)
      .executeTakeFirst();
    if (!held) return null;
  }
  const stored = await context.db
    .selectFrom('artifacts')
    .select('extracted_text')
    .where('id', '=', row.id)
    .executeTakeFirst();
  const cipher = await fileCipherFor(context, row);
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    blobKey: row.blobKey,
    extractedText:
      stored?.extracted_text && cipher
        ? openText(stored.extracted_text, cipher)
        : stored?.extracted_text
          ? '[content unavailable: no key for this file]'
          : null,
    extractStatus: row.extractStatus,
    cipher,
  };
}

export function attachmentTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'chat_read_attachment',
        description:
          'Read the text of a file attached to this chat or its project, by attachment id, in pages. Returns up to maxChars characters starting at offset, and says how much remains.',
        inputSchema: {
          type: 'object',
          properties: {
            attachmentId: { type: 'string' },
            offset: {
              type: 'integer',
              minimum: 0,
              description: 'Character offset to start at (default 0).',
            },
            maxChars: {
              type: 'integer',
              minimum: 1,
              maximum: READ_MAX_CHARS,
              description: `Characters to return (default ${READ_DEFAULT_CHARS}).`,
            },
          },
          required: ['attachmentId'],
        },
      },
      readOnly: true,
      async execute(input, context) {
        const id = typeof input.attachmentId === 'string' ? input.attachmentId : '';
        const attachment = await findAttachment(context, id);
        if (!attachment) return errorResult('No such attachment in this chat.');
        if (!attachment.extractedText) {
          return errorResult(
            attachment.extractStatus === 'unsupported'
              ? `${attachment.filename} is ${attachment.contentType}; no text could be extracted from it. Stage it into the sandbox with chat_attach_to_sandbox to work with the bytes.`
              : `No text is available for ${attachment.filename} (${attachment.extractStatus}).`
          );
        }
        const offset =
          typeof input.offset === 'number' && input.offset >= 0 ? Math.floor(input.offset) : 0;
        const max =
          typeof input.maxChars === 'number' && input.maxChars > 0
            ? Math.min(READ_MAX_CHARS, Math.floor(input.maxChars))
            : READ_DEFAULT_CHARS;
        const text = attachment.extractedText;
        const page = text.slice(offset, offset + max);
        const remaining = Math.max(0, text.length - (offset + page.length));
        return textResult(
          `${attachment.filename} — characters ${offset}–${offset + page.length} of ${text.length}${remaining > 0 ? ` (${remaining} remaining; call again with offset ${offset + page.length})` : ''}:\n\n${page}`
        );
      },
    },
  ];
}
