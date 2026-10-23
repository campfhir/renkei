/**
 * Artifacts — a chat's attachments and a project's files, one kind of
 * row (migration 163): bytes in the org's object store, a metadata row
 * here, and the text extracted at upload so the model can read a file on
 * any provider. A row belongs to the person who uploaded it (or whose
 * chat produced it); a chat holds it by `chat_id`, a project through an
 * `artifact_references` row that also says how the project's chats use
 * it. Every operation is scoped by the owner (uploads) or by the access
 * the caller already resolved (reads — artifact-access.ts).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmContentBlock } from '@renkei/agent-llm';
import { chatAttachmentKey, resolveTenantBlobStore } from '@renkei/blob-store';
import { extractText, isExtractableCandidate } from '@renkei/document-text';
import { callMistralOcr, resolveMistralOcrConfig } from '@renkei/connector-mistral-ocr';
import { getOrgSettings, getKeyDomain } from '@renkei/settings';
import { randomUUID } from 'node:crypto';
import { isUuid } from '@/lib/uuid';
import { openText, sealText, type ContentCipher } from './content-crypto';
import type { OutboundRedactor } from './outbound-redaction';
import type { AttachmentView } from './views';

/** What a prompt inlines per attachment; the rest is read on demand. */
export const INLINE_EXCERPT_CHARS = 40_000;
/** What is kept of the extracted text at all. */
export const EXTRACTED_TEXT_MAX_CHARS = 200_000;

/** Extract status of a file whose text needs OCR: a scan, or an image. */
export const NEEDS_OCR = 'needs_ocr';
const OCR_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/tiff']);
/** How many files one OCR pass works on at once. */
const OCR_CONCURRENCY = 3;

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

/**
 * Which key seals a row's extracted text: its own (`artifact`), or —
 * a plain chat upload, or a row from before artifacts had keys of their
 * own — the key of the chat or project it lives in (`key_ref`).
 */
export type ArtifactKeyKind = 'artifact' | 'chat' | 'chat_project';

export interface AttachmentRow {
  id: string;
  ownerSubject: string;
  /** The chat it was uploaded to or produced in; null once that chat is gone, or for a library upload. */
  chatId: string | null;
  messageId: string | null;
  blobKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  extractStatus: string;
  /** `upload` (a person's file) or `model` (a file a tool handed back). */
  origin: string;
  keyKind: ArtifactKeyKind;
  keyRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** How a project's chats use one artifact (artifact_references.mode). */
export type ReferenceMode = 'always' | 'on_demand';

export function isReferenceMode(value: unknown): value is ReferenceMode {
  return value === 'always' || value === 'on_demand';
}

/** An artifact as one project holds it. */
export interface ProjectArtifactRow extends AttachmentRow {
  referenceId: string;
  mode: ReferenceMode;
  addedBy: string;
}

const COLUMNS = [
  'id',
  'owner_subject',
  'chat_id',
  'message_id',
  'blob_key',
  'filename',
  'content_type',
  'size_bytes',
  'extract_status',
  'origin',
  'key_kind',
  'key_ref',
  'created_at',
  'updated_at',
] as const;

function rowOf(raw: {
  id: string;
  owner_subject: string;
  chat_id: string | null;
  message_id: string | null;
  blob_key: string;
  filename: string;
  content_type: string;
  size_bytes: string | number | bigint;
  extract_status: string;
  origin: string;
  key_kind: string;
  key_ref: string | null;
  created_at: Date;
  updated_at: Date;
}): AttachmentRow {
  return {
    id: raw.id,
    ownerSubject: raw.owner_subject,
    chatId: raw.chat_id,
    messageId: raw.message_id,
    blobKey: raw.blob_key,
    filename: raw.filename,
    contentType: raw.content_type,
    sizeBytes: Number(raw.size_bytes),
    extractStatus: raw.extract_status,
    origin: raw.origin,
    keyKind: raw.key_kind === 'chat' || raw.key_kind === 'chat_project' ? raw.key_kind : 'artifact',
    keyRef: raw.key_ref,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function toAttachmentView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    extractStatus: row.extractStatus,
    messageId: row.messageId,
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
  if (OCR_IMAGE_TYPES.has(contentType)) return { text: null, status: NEEDS_OCR };
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
  if (result.val.notes.includes('scanned-pdf')) return { text: null, status: NEEDS_OCR };
  return { text: result.val.text.slice(0, EXTRACTED_TEXT_MAX_CHARS), status: 'done' };
}

/**
 * OCRs one file that came up as needs_ocr and stores the text. A file
 * OCR cannot read is marked ocr_failed, so a mass upload never retries
 * the same file forever; with no OCR connector the file stays needs_ocr.
 */
async function ocrOne(
  db: Kysely<DB>,
  row: AttachmentRow,
  redactor: OutboundRedactor | null,
  cipher: ContentCipher
): Promise<string> {
  const config = await resolveMistralOcrConfig();
  if (!config.ok) return NEEDS_OCR;
  const store = await resolveTenantBlobStore();
  if (!store.ok) return NEEDS_OCR;
  const object = await store.val.getObject(row.blobKey);
  if (!object.ok) return 'ocr_failed';
  const ocr = await callMistralOcr(config.val, {
    bytes: object.val.bytes,
    filename: row.filename,
    contentType: row.contentType,
  });
  const markdown = ocr.ok
    ? ocr.val.pages
        .map((page) => page.markdown)
        .join('\n\n')
        .slice(0, EXTRACTED_TEXT_MAX_CHARS)
    : '';
  if (!ocr.ok || !markdown.trim()) {
    // An unreachable service is worth another try; anything else is the file.
    return ocr.ok || ocr.err.type !== 'unreachable' ? 'ocr_failed' : NEEDS_OCR;
  }
  const sealed = sealText(redactor ? redactor.apply(markdown).text : markdown, cipher);
  if (!sealed.ok) return NEEDS_OCR;
  await db
    .updateTable('artifacts')
    .set({ extracted_text: sealed.val, extract_status: 'done', updated_at: new Date() })
    .where('id', '=', row.id)
    .execute();
  return 'done';
}

/**
 * OCRs the caller's unsent files in a chat that still need it, a few at
 * a time, and returns each one's resulting status. The composer calls
 * this after a mass upload and repeats it for whatever is still
 * needs_ocr, so it is safe to call twice and to interrupt.
 */
export async function ocrChatAttachments(
  db: Kysely<DB>,
  input: {
    ownerSubject: string;
    chatId: string;
    attachmentIds: string[];
    redactor: OutboundRedactor | null;
    /** The chat's cipher: the text lands under the chat's key. */
    cipher: ContentCipher;
  }
): Promise<Array<{ id: string; extractStatus: string }>> {
  const ids = input.attachmentIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = (
    await db
      .selectFrom('artifacts')
      .select(COLUMNS)
      .where('owner_subject', '=', input.ownerSubject)
      .where('chat_id', '=', input.chatId)
      .where('extract_status', '=', NEEDS_OCR)
      .where('id', 'in', ids)
      .execute()
  ).map(rowOf);
  const results: Array<{ id: string; extractStatus: string }> = [];
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      results.push({
        id: row.id,
        extractStatus: await ocrOne(db, row, input.redactor, input.cipher),
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, rows.length) }, lane));
  return results;
}

export async function createAttachment(
  db: Kysely<DB>,
  input: {
    /** Chosen ahead when the row's own key is minted first (artifact-library.ts). */
    id?: string;
    ownerSubject: string;
    chatId: string | null;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    maxBytes: number;
    redactor: OutboundRedactor | null;
    /** The cipher the text is sealed under — the key `key` names. */
    cipher: ContentCipher;
    /** Which key `cipher` is: the chat's (a plain chat upload) or the artifact's own. */
    key: { kind: 'chat'; ref: string } | { kind: 'artifact' };
    /** A file a tool produced hangs off the tool-results row it came with. */
    origin?: 'upload' | 'model';
    messageId?: string | null;
  }
): Promise<Result<AttachmentRow, AttachmentError>> {
  if (input.bytes.byteLength > input.maxBytes) return err('TOO_LARGE' as const);
  const store = await resolveTenantBlobStore();
  if (!store.ok) return err('UNCONFIGURED' as const);
  const id = input.id ?? randomUUID();
  const key = chatAttachmentKey(await getKeyDomain(), id);
  if (!key.ok) return err('STORE' as const);

  const filename = cleanFilename(input.filename);
  const contentType = cleanContentType(input.contentType);
  const extracted = await extract(input.bytes, filename, contentType);
  let sealedText: string | null = null;
  if (extracted.text !== null) {
    const text = input.redactor ? input.redactor.apply(extracted.text).text : extracted.text;
    const sealed = sealText(text, input.cipher);
    if (!sealed.ok) return err('CONTENT_KEY' as const);
    sealedText = sealed.val;
  }

  const put = await store.val.putObject(key.val, input.bytes, contentType);
  if (!put.ok) return err('STORE' as const, { message: put.err.message });
  try {
    const inserted = await db
      .insertInto('artifacts')
      .values({
        id,
        owner_subject: input.ownerSubject,
        chat_id: input.chatId,
        message_id: input.messageId ?? null,
        origin: input.origin ?? 'upload',
        key_kind: input.key.kind,
        key_ref: input.key.kind === 'chat' ? input.key.ref : null,
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

/** The files tools produced in this chat — what the Artifacts button lists. */
export async function listArtifacts(db: Kysely<DB>, chatId: string): Promise<AttachmentRow[]> {
  if (!isUuid(chatId)) return [];
  const rows = await db
    .selectFrom('artifacts')
    .select(COLUMNS)
    .where('chat_id', '=', chatId)
    .where('origin', '=', 'model')
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(rowOf);
}

export async function getAttachment(
  db: Kysely<DB>,
  attachmentId: string
): Promise<AttachmentRow | null> {
  if (!isUuid(attachmentId)) return null;
  const raw = await db
    .selectFrom('artifacts')
    .select(COLUMNS)
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  return raw ? rowOf(raw) : null;
}

export async function getAttachments(db: Kysely<DB>, ids: string[]): Promise<AttachmentRow[]> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return [];
  const rows = await db.selectFrom('artifacts').select(COLUMNS).where('id', 'in', valid).execute();
  return rows.map(rowOf);
}

/** The text extracted at upload (redacted as the model saw it), or null when there is none. */
export async function getAttachmentText(
  db: Kysely<DB>,
  attachmentId: string,
  cipher: ContentCipher
): Promise<string | null> {
  if (!isUuid(attachmentId)) return null;
  const raw = await db
    .selectFrom('artifacts')
    .select('extracted_text')
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  return raw?.extracted_text ? openText(raw.extracted_text, cipher) : null;
}

/** The files uploaded to or produced in one chat, oldest first. */
export async function listAttachments(
  db: Kysely<DB>,
  home: { chatId: string }
): Promise<AttachmentRow[]> {
  if (!isUuid(home.chatId)) return [];
  const rows = await db
    .selectFrom('artifacts')
    .select(COLUMNS)
    .where('chat_id', '=', home.chatId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(rowOf);
}

const REFERENCE_COLUMNS = [
  'r.id as reference_id',
  'r.mode',
  'r.added_by',
  'a.id',
  'a.owner_subject',
  'a.chat_id',
  'a.message_id',
  'a.blob_key',
  'a.filename',
  'a.content_type',
  'a.size_bytes',
  'a.extract_status',
  'a.origin',
  'a.key_kind',
  'a.key_ref',
  'a.created_at',
  'a.updated_at',
] as const;

function projectRowOf(raw: {
  reference_id: string;
  mode: string;
  added_by: string;
  id: string;
  owner_subject: string;
  chat_id: string | null;
  message_id: string | null;
  blob_key: string;
  filename: string;
  content_type: string;
  size_bytes: string | number | bigint;
  extract_status: string;
  origin: string;
  key_kind: string;
  key_ref: string | null;
  created_at: Date;
  updated_at: Date;
}): ProjectArtifactRow {
  return {
    ...rowOf(raw),
    referenceId: raw.reference_id,
    mode: raw.mode === 'always' ? 'always' : 'on_demand',
    addedBy: raw.added_by,
  };
}

/** The artifacts one project holds, in the order they were attached. */
export async function listProjectArtifacts(
  db: Kysely<DB>,
  projectId: string
): Promise<ProjectArtifactRow[]> {
  if (!isUuid(projectId)) return [];
  const rows = await db
    .selectFrom('artifact_references as r')
    .innerJoin('artifacts as a', 'a.id', 'r.artifact_id')
    .select(REFERENCE_COLUMNS)
    .where('r.project_id', '=', projectId)
    .orderBy('r.created_at', 'asc')
    .execute();
  return rows.map(projectRowOf);
}

/** One artifact as one project holds it, or null when the project does not. */
export async function getProjectArtifact(
  db: Kysely<DB>,
  projectId: string,
  artifactId: string
): Promise<ProjectArtifactRow | null> {
  if (!isUuid(projectId) || !isUuid(artifactId)) return null;
  const raw = await db
    .selectFrom('artifact_references as r')
    .innerJoin('artifacts as a', 'a.id', 'r.artifact_id')
    .select(REFERENCE_COLUMNS)
    .where('r.project_id', '=', projectId)
    .where('r.artifact_id', '=', artifactId)
    .executeTakeFirst();
  return raw ? projectRowOf(raw) : null;
}

/** The projects that hold one artifact. */
export async function listReferencesOf(
  db: Kysely<DB>,
  artifactId: string
): Promise<{ referenceId: string; projectId: string; mode: ReferenceMode; addedBy: string }[]> {
  if (!isUuid(artifactId)) return [];
  const rows = await db
    .selectFrom('artifact_references')
    .select(['id', 'project_id', 'mode', 'added_by'])
    .where('artifact_id', '=', artifactId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((row) => ({
    referenceId: row.id,
    projectId: row.project_id,
    mode: row.mode === 'always' ? 'always' : 'on_demand',
    addedBy: row.added_by,
  }));
}

/** Attaches (or re-attaches, keeping the row) an artifact to a project. */
export async function addProjectReference(
  db: Kysely<DB>,
  input: { artifactId: string; projectId: string; mode: ReferenceMode; addedBy: string }
): Promise<{ referenceId: string }> {
  const row = await db
    .insertInto('artifact_references')
    .values({
      artifact_id: input.artifactId,
      project_id: input.projectId,
      mode: input.mode,
      added_by: input.addedBy,
    })
    .onConflict((oc) => oc.columns(['artifact_id', 'project_id']).doUpdateSet({ mode: input.mode }))
    .returning('id')
    .executeTakeFirstOrThrow();
  return { referenceId: row.id };
}

export async function setReferenceMode(
  db: Kysely<DB>,
  input: { artifactId: string; projectId: string; mode: ReferenceMode }
): Promise<boolean> {
  const result = await db
    .updateTable('artifact_references')
    .set({ mode: input.mode })
    .where('artifact_id', '=', input.artifactId)
    .where('project_id', '=', input.projectId)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Detaches an artifact from a project; the artifact itself stays. */
export async function removeProjectReference(
  db: Kysely<DB>,
  input: { artifactId: string; projectId: string }
): Promise<boolean> {
  const result = await db
    .deleteFrom('artifact_references')
    .where('artifact_id', '=', input.artifactId)
    .where('project_id', '=', input.projectId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/** Deletes the row and then the bytes; a missing object is not a failure. */
export async function deleteAttachment(db: Kysely<DB>, row: AttachmentRow): Promise<boolean> {
  const result = await db.deleteFrom('artifacts').where('id', '=', row.id).executeTakeFirst();
  if (Number(result.numDeletedRows) === 0) return false;
  const store = await resolveTenantBlobStore();
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
  ownerSubject: string,
  chatId: string,
  attachmentIds: string[],
  cipher: ContentCipher
): Promise<LlmContentBlock[]> {
  const ids = attachmentIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('artifacts')
    .select([...COLUMNS, 'extracted_text'])
    .where('owner_subject', '=', ownerSubject)
    .where('chat_id', '=', chatId)
    .where('message_id', 'is', null)
    .where('id', 'in', ids)
    .orderBy('created_at', 'asc')
    .execute();
  const settings = await getOrgSettings();
  const threshold = settings.ok ? settings.val.massUploadThreshold : 10;
  if (rows.length > threshold) return [massUploadManifest(rows.map(rowOf))];
  const blocks: LlmContentBlock[] = [];
  const store = await resolveTenantBlobStore();
  for (const raw of rows) {
    const row = rowOf(raw);
    const text = raw.extracted_text ? openText(raw.extracted_text, cipher) : null;
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

/**
 * A mass upload is sent as a list, not as text: hundreds of inlined
 * excerpts would not fit any context window. The model reads each file
 * with chat_read_attachment, one at a time or as its task calls for.
 */
export function massUploadManifest(rows: AttachmentRow[]): LlmContentBlock {
  const lines = rows.map(
    (row) =>
      `- id=${row.id} name="${row.filename}" type=${row.contentType} size=${row.sizeBytes} text=${
        row.extractStatus === 'done'
          ? 'ready'
          : row.extractStatus === NEEDS_OCR
            ? 'ocr-pending'
            : row.extractStatus
      }`
  );
  return {
    type: 'text',
    text:
      `<attachments count="${rows.length}" mode="manifest">\n` +
      `${rows.length} files were attached at once, so their contents are not inlined. ` +
      'Read each with chat_read_attachment (by id, in pages). text=ocr-pending means OCR has not ' +
      'finished for that file yet; text=ocr_failed or unsupported means no text is available ' +
      '(chat_attach_to_sandbox stages the bytes).\n' +
      `${lines.join('\n')}\n</attachments>`,
  };
}
