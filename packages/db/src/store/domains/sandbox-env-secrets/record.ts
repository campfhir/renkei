import type { Selectable } from 'kysely';
import type { SandboxEnvSecrets } from '../../../db.types';
import type { SandboxEnvSecretRecord } from './types';

export function envSecretFromRow(row: Selectable<SandboxEnvSecrets>): SandboxEnvSecretRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  };
}
