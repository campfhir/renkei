/**
 * chat_read_attachment / chat_attach_to_sandbox — the model's hands on
 * the files a person uploaded. Reading pages through the text extracted
 * at upload (so a document is legible on any provider); staging copies
 * the bytes into the person's sandbox so every sandbox_* tool can act on
 * them. Both check that the attachment belongs to this chat or its
 * project — an id from elsewhere is "not found".
 */

import { sbWriteFile, sandboxConfig } from '@renkei/sandbox-client';
import { getBlobStore } from '@renkei/blob-store';
import { openText } from './content-crypto';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from './local-tools';
import type { ChatToolConfig } from './tool-config';

const READ_DEFAULT_CHARS = 20_000;
const READ_MAX_CHARS = 80_000;

async function findAttachment(
  context: LocalToolContext,
  attachmentId: string
): Promise<{
  id: string;
  filename: string;
  contentType: string;
  blobKey: string;
  extractedText: string | null;
  extractStatus: string;
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return null;
  const row = await context.db
    .selectFrom('chat_attachments')
    .select(['id', 'filename', 'content_type', 'blob_key', 'extracted_text', 'extract_status'])
    .where('tenant_id', '=', context.tenantId)
    .where('id', '=', attachmentId)
    .where((eb) =>
      eb.or([
        eb('chat_id', '=', context.chatId),
        ...(context.projectId ? [eb('project_id', '=', context.projectId)] : []),
      ])
    )
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    blobKey: row.blob_key,
    extractedText: row.extracted_text ? openText(row.extracted_text) : null,
    extractStatus: row.extract_status,
  };
}

export function attachmentTools(toolConfig: ChatToolConfig): LocalTool[] {
  const tools: LocalTool[] = [
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
  if (toolConfig.connectors.includes('sandbox') && sandboxConfig()) {
    tools.push({
      def: {
        name: 'chat_attach_to_sandbox',
        description:
          'Copy a file attached to this chat or its project into your sandbox scratch space, by attachment id, so the sandbox_* tools (read, OCR, send to an upload, the browser) can work with its bytes. Returns the staged file.',
        inputSchema: {
          type: 'object',
          properties: { attachmentId: { type: 'string' } },
          required: ['attachmentId'],
        },
      },
      async execute(input, context) {
        const id = typeof input.attachmentId === 'string' ? input.attachmentId : '';
        const attachment = await findAttachment(context, id);
        if (!attachment) return errorResult('No such attachment in this chat.');
        const store = getBlobStore();
        if (!store.ok) return errorResult('No file store is configured.');
        const object = await store.val.getObject(attachment.blobKey);
        if (!object.ok) return errorResult(`The file could not be read (${object.err.type}).`);
        const staged = await sbWriteFile(
          { tenantId: context.tenantId, subject: context.subject },
          { filename: attachment.filename, contentType: attachment.contentType, source: 'chat' },
          object.val.bytes
        );
        if (!staged.ok) return errorResult(`The sandbox refused the file (${staged.err.kind}).`);
        return textResult(
          `Staged ${staged.val.filename} in the sandbox as file ${staged.val.id} (${staged.val.sizeBytes} bytes, ${staged.val.contentType ?? attachment.contentType}).`
        );
      },
    });
  }
  return tools;
}
