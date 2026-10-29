import type { GrantSummary } from './types';

export const GRANT_COLUMNS = [
  'provider',
  'provider_account_id',
  'subject',
  'display_name',
  'expires_at',
  'metadata',
  'created_at',
] as const;

export function grantFromRow(row: {
  provider: string;
  provider_account_id: string;
  subject: string | null;
  display_name: string;
  expires_at: Date | string;
  metadata: unknown;
  created_at: Date | string;
}): GrantSummary {
  return {
    provider: row.provider,
    accountId: row.provider_account_id,
    subject: row.subject,
    displayName: row.display_name,
    expiresAt: new Date(row.expires_at),
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
  };
}
