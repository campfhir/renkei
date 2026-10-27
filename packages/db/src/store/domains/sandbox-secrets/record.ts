import type { Selectable } from 'kysely';
import type { SandboxSecrets } from '../../../db.types';
import type { SandboxSecretRecord } from './types';

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function sandboxSecretFromRow(row: Selectable<SandboxSecrets>): SandboxSecretRecord {
  return {
    id: row.id,
    subject: row.subject,
    name: row.name,
    fields: strings(row.field_names),
    hosts: strings(row.hosts),
    sealed: row.sealed,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  };
}

export function sandboxSecretValues(secret: Omit<SandboxSecretRecord, 'createdAt' | 'lastUsedAt'>) {
  return {
    id: secret.id,
    subject: secret.subject,
    name: secret.name,
    field_names: JSON.stringify(secret.fields),
    hosts: JSON.stringify(secret.hosts),
    sealed: secret.sealed,
    expires_at: secret.expiresAt,
  };
}
