import type { Selectable } from 'kysely';
import type { DeviceKeyRequests } from '../../../db.types';
import type { DeviceKeyRequestRecord } from './types';

export function deviceKeyRequestFromRow(
  row: Selectable<DeviceKeyRequests>
): DeviceKeyRequestRecord {
  return {
    id: row.id,
    subject: row.subject,
    publicKey: row.public_key,
    code: row.code,
    sealedKey: row.sealed_key,
    askingSessionId: row.asking_session_id,
    userAgent: row.user_agent,
    attempts: row.attempts,
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    deniedAt: row.denied_at ? new Date(row.denied_at) : null,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
  };
}
