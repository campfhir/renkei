import type { Selectable } from 'kysely';
import type { Artifacts } from '../../../db.types';
import type { ArtifactRecord } from './types';

/** Every column but the sealed text and the search index. */
export const ARTIFACT_COLUMNS = [
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
  'summary',
  'keywords',
  'digest_status',
  'ocr_started_at',
  'ocr_finished_at',
  'ocr_pages',
  'ocr_millis',
  'created_at',
  'updated_at',
] as const;

type ArtifactRow = Pick<Selectable<Artifacts>, (typeof ARTIFACT_COLUMNS)[number]>;

const dateOrNull = (value: Date | string | null) => (value ? new Date(value) : null);

export function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    ownerSubject: row.owner_subject,
    chatId: row.chat_id,
    messageId: row.message_id,
    blobKey: row.blob_key,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    extractStatus: row.extract_status,
    origin: row.origin,
    keyKind: row.key_kind,
    keyRef: row.key_ref,
    summary: row.summary,
    keywords: row.keywords,
    digestStatus: row.digest_status,
    ocrStartedAt: dateOrNull(row.ocr_started_at),
    ocrFinishedAt: dateOrNull(row.ocr_finished_at),
    ocrPages: row.ocr_pages,
    ocrMillis: row.ocr_millis,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** `%` and `_` in a term are characters to find, not wildcards. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
