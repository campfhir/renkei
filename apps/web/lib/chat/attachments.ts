/**
 * Chat attachments: bytes in the org's object store, a metadata row
 * here, and the text extracted at upload so the model can read a file on
 * any provider. Every operation is scoped by the owner (uploads) or by
 * the chat/project access the caller already resolved (reads).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmContentBlock } from '@renkei/agent-llm';
import { chatAttachmentKey, getBlobStore } from '@renkei/blob-store';
import { extractText, isExtractableCandidate } from '@renkei/document-text';
import { randomUUID } from 'node:crypto';
import { isUuid } from '@/lib/uuid';
import { openText, sealText } from './content-crypto';
import type { OutboundRedactor } from './outbound-redaction';
import type { AttachmentView } from './views';

/** What a prompt inlines per attachment; the rest is read on demand. */
export const INLINE_EXCERPT_CHARS = 40_000;
/** What is kept of the extracted text at all. */
export const EXTRACTED_TEXT_MAX_CHARS = 200_000;

const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/html',
  'text/xml',
]);

export type AttachmentError = 'UNCONFIGURED' | 'TOO_LARGE' | 'STORE' | 'CONTENT_KEY' | 'DB_ERROR';

export interface AttachmentRow {
  id: string;
  ownerSubject: string;
  chatId: string | null;
  projectId: string | null;
  messageId: string | null;
  blobKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  extractStatus: string;
  createdAt: Date;
}

const COLUMNS = [
  'id',
  'owner_subject',
  'chat_id',
  'project_id',
  'message_id',
  'blob_key',
  'filename',
  'content_type',
  'size_bytes',
  'extract_status',
  'created_at',
] as const;

function rowOf(raw: {
  id: string;
  owner_subject: string;
  chat_id: string | null;
  project_id: string | null;
  message_id: string | null;
  blob_key: string;
  filename: string;
  content_type: string;
  size_bytes: string | number | bigint;
  extract_status: string;
  created_at: Date;
}): AttachmentRow {
  return {
    id: raw.id,
    ownerSubject: raw.owner_subject,
    chatId: raw.chat_id,
    projectId: raw.project_id,
    messageId: raw.message_id,
    blobKey: raw.blob_key,
    filename: raw.filename,
    contentType: raw.content_type,
    sizeBytes: Number(raw.size_bytes),
    extractStatus: raw.extract_status,
    createdAt: raw.created_at,
  };
}

export function toAttachmentView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    extractStatus: row.extractStatus,
  };
}

/** Filenames are display labels: trimmed, path-free, bounded. */
export function cleanFilename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(base)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .trim();
  return (cleaned || 'file').slice(0, 255);
}

export function cleanContentType(value: string | null): string {
  const type = (value ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)
    ? type.slice(0, 127)
    : 'application/octet-stream';
}

async function extract(
  bytes: Uint8Array,
  filename: string,
  contentType: string
): Promise<{ text: string | null; status: string }> {
  if (TEXT_TYPES.has(contentType) || contentType.startsWith('text/')) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return { text: text.slice(0, EXTRACTED_TEXT_MAX_CHARS), status: 'done' };
  }
  if (!isExtractableCandidate({ fileName: filename, contentType })) {
    return { text: null, status: 'unsupported' };
  }
  const result = await extractText(bytes, {
    fileName: filename,
    contentType,
    maxChars: EXTRACTED_TEXT_MAX_CHARS,
  });
  if (!result.ok) {
    return {
      text: null,
      status:
        result.err.type === 'UNSUPPORTED_FORMAT'
          ? 'unsupported'
          : result.err.type === 'INPUT_TOO_LARGE'
            ? 'too_large'
            : 'failed',
    };
  }
  return { text: result.val.text.slice(0, EXTRACTED_TEXT_MAX_CHARS), status: 'done' };
}

export async function createAttachment(
  db: Kysely<DB>,
  input: {
    tenantId: string;
    ownerSubject: string;
    chatId: string | null;
    projectId: string | null;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    maxBytes: number;
    redactor: OutboundRedactor | null;
  }
): Promise<Result<AttachmentRow, AttachmentError>> {
  if (input.bytes.byteLength > input.maxBytes) return err('TOO_LARGE' as const);
  const store = getBlobStore();
  if (!store.ok) return err('UNCONFIGURED' as const);
  const id = randomUUID();
  const key = chatAttachmentKey(input.tenantId, id);
  if (!key.ok) return err('STORE' as const);

  const filename = cleanFilename(input.filename);
  const contentType = cleanContentType(input.contentType);
  const extracted = await extract(input.bytes, filename, contentType);
  let sealedText: string | null = null;
  if (extracted.text !== null) {
    const text = input.redactor ? input.redactor.apply(extracted.text).text : extracted.text;
    const sealed = sealText(text);
    if (!sealed.ok) return err('CONTENT_KEY' as const);
    sealedText = sealed.val;
  }

  const put = await store.val.putObject(key.val, input.bytes, contentType);
  if (!put.ok) return err('STORE' as const, { message: put.err.message });
  try {
    const inserted = await db
      .insertInto('chat_attachments')
      .values({
        id,
        tenant_id: input.tenantId,
        owner_subject: input.ownerSubject,
        chat_id: input.chatId,
        project_id: input.projectId,
        blob_key: key.val,
        filename,
        content_type: contentType,
        size_bytes: input.bytes.byteLength,
        extracted_text: sealedText,
        extract_status: extracted.status,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return ok(rowOf(inserted));
  } catch (error) {
    // Never leave bytes without a row: the sweep would not know about them.
    await store.val.deleteObject(key.val);
    return err('DB_ERROR' as const, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAttachment(
  db: Kysely<DB>,
  tenantId: string,
  attachmentId: string
): Promise<AttachmentRow | null> {
  if (!isUuid(attachmentId)) return null;
  const raw = await db
    .selectFrom('chat_attachments')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  return raw ? rowOf(raw) : null;
}

export async function listAttachments(
  db: Kysely<DB>,
  tenantId: string,
  home: { chatId: string } | { projectId: string }
): Promise<AttachmentRow[]> {
  let query = db.selectFrom('chat_attachments').select(COLUMNS).where('tenant_id', '=', tenantId);
  query =
    'chatId' in home
      ? query.where('chat_id', '=', home.chatId)
      : query.where('project_id', '=', home.projectId);
  const rows = await query.orderBy('created_at', 'asc').execute();
  return rows.map(rowOf);
}

/** Deletes the row and then the bytes; a missing object is not a failure. */
export async function deleteAttachment(
  db: Kysely<DB>,
  tenantId: string,
  row: AttachmentRow
): Promise<boolean> {
  const result = await db
    .deleteFrom('chat_attachments')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', row.id)
    .executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) return false;
  const store = getBlobStore();
  if (store.ok) await store.val.deleteObject(row.blobKey);
  return true;
}

/**
 * The blocks a prompt carries for the files sent with it: an excerpt of
 * each file's text (the model reads the rest with chat_read_attachment),
 * and for PDFs and images a document/image block the provider can render
 * — the OpenAI dialect degrades those to a placeholder in its adapter.
 */
export async function attachmentPromptBlocks(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  chatId: string,
  attachmentIds: string[]
): Promise<LlmContentBlock[]> {
  const ids = attachmentIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('chat_attachments')
    .select([...COLUMNS, 'extracted_text'])
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('chat_id', '=', chatId)
    .where('message_id', 'is', null)
    .where('id', 'in', ids)
    .orderBy('created_at', 'asc')
    .execute();
  const blocks: LlmContentBlock[] = [];
  const store = getBlobStore();
  for (const raw of rows) {
    const row = rowOf(raw);
    const text = raw.extracted_text ? openText(raw.extracted_text) : null;
    const excerpt = text ? text.slice(0, INLINE_EXCERPT_CHARS) : null;
    const clipped = text !== null && text.length > INLINE_EXCERPT_CHARS;
    blocks.push({
      type: 'text',
      text:
        `<attachment id="${row.id}" name="${row.filename}" type="${row.contentType}" size="${row.sizeBytes}">\n` +
        (excerpt !== null
          ? `${excerpt}${clipped ? `\n…[${text.length - INLINE_EXCERPT_CHARS} more characters; read on with chat_read_attachment]` : ''}`
          : `[no text could be extracted (${row.extractStatus}); chat_attach_to_sandbox stages the bytes]`) +
        '\n</attachment>',
    });
    const renderable =
      row.contentType === 'application/pdf' ||
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(row.contentType);
    if (renderable && store.ok && row.sizeBytes <= 8_000_000) {
      const object = await store.val.getObject(row.blobKey);
      if (object.ok) {
        const dataBase64 = Buffer.from(object.val.bytes).toString('base64');
        blocks.push(
          row.contentType === 'application/pdf'
            ? { type: 'document', mediaType: row.contentType, dataBase64, title: row.filename }
            : { type: 'image', mediaType: row.contentType, dataBase64 }
        );
      }
    }
  }
  return blocks;
}
