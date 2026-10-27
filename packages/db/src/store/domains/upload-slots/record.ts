import type { Selectable } from 'kysely';
import type { UploadSlots } from '../../../db.types';
import type { UploadSlotRecord } from './types';

/** Every column but the bearer's hash. */
export const UPLOAD_SLOT_COLUMNS = [
  'id',
  'subject',
  'account_id',
  'kind',
  'destination',
  'filename',
  'content_type',
  'max_bytes',
  'status',
  'result',
  'expires_at',
  'completed_at',
  'created_at',
] as const;

type UploadSlotRow = Pick<Selectable<UploadSlots>, (typeof UPLOAD_SLOT_COLUMNS)[number]>;

export function uploadSlotFromRow(row: UploadSlotRow): UploadSlotRecord {
  return {
    id: row.id,
    subject: row.subject,
    accountId: row.account_id,
    kind: row.kind,
    destination: row.destination,
    filename: row.filename,
    contentType: row.content_type,
    maxBytes: row.max_bytes,
    status: row.status,
    result: row.result,
    expiresAt: new Date(row.expires_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    createdAt: new Date(row.created_at),
  };
}
