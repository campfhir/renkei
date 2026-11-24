import type { Selectable } from 'kysely';
import type { CiHealthCheckins } from '../../../db.types';
import type { CiHealthRecord } from './types';

const date = (value: Date | string | null) => (value === null ? null : new Date(value));

export function ciHealthFromRow(row: Selectable<CiHealthCheckins>): CiHealthRecord {
  return {
    projectId: row.project_id,
    environment: row.environment,
    tokenHint: row.token_hint,
    issuedBy: row.issued_by,
    issuedAt: new Date(row.issued_at),
    status: row.status,
    message: row.message,
    version: row.version,
    sentAt: date(row.sent_at),
    receivedAt: date(row.received_at),
    intervalSeconds: row.interval_seconds,
    checkins: row.checkins,
  };
}
