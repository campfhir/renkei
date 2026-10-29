import type { Selectable } from 'kysely';
import type { FileShares } from '../../../db.types';
import type { FileShareConnectionRecord, FileShareInput, FileShareRecord } from './types';

export function fileShareFromRow(row: Selectable<FileShares>): FileShareRecord {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    shareName: row.share_name,
    rootPath: row.root_path,
    caseInsensitive: row.case_insensitive,
    enabled: row.enabled,
    hostKeyFingerprint: row.host_key_fingerprint,
    settings: row.settings ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function connectionFromRow(row: {
  username: string;
  tool_access: string;
  allow_delete: boolean;
  encrypted_credentials: string;
}): FileShareConnectionRecord {
  return {
    username: row.username,
    toolAccess: row.tool_access,
    allowDelete: row.allow_delete === true,
    encryptedCredentials: row.encrypted_credentials,
  };
}

export function shareValues(share: FileShareInput) {
  return {
    name: share.name,
    protocol: share.protocol,
    host: share.host,
    port: share.port,
    share_name: share.shareName,
    root_path: share.rootPath,
    case_insensitive: share.caseInsensitive,
    enabled: share.enabled,
    host_key_fingerprint: share.hostKeyFingerprint,
  };
}
