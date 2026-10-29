import type { Selectable } from 'kysely';
import type { SandboxFiles } from '../../../db.types';
import type { SandboxFileRecord } from './types';

export function sandboxFileFromRow(row: Selectable<SandboxFiles>): SandboxFileRecord {
  return {
    id: row.id,
    subject: row.subject,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key,
    source: row.source,
    batchId: row.batch_id,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  };
}

export function sandboxFileValues(file: Omit<SandboxFileRecord, 'createdAt'>) {
  return {
    id: file.id,
    subject: file.subject,
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    storage_key: file.storageKey,
    source: file.source,
    batch_id: file.batchId,
    expires_at: file.expiresAt,
  };
}
