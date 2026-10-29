import type {
  ProviderGrantSealedInput,
  ProviderGrantSealedRecord,
  ProviderGrantSummaryRecord,
} from './types';

export function grantSummaryFromRow(row: {
  provider: string;
  provider_account_id: string;
  subject: string | null;
  display_name: string;
  requested_scopes: string[] | null;
  granted_scopes: string[] | null;
  metadata: unknown;
}): ProviderGrantSummaryRecord {
  return {
    provider: row.provider,
    accountId: row.provider_account_id,
    subject: row.subject,
    displayName: row.display_name,
    requestedScopes: row.requested_scopes ?? [],
    grantedScopes: row.granted_scopes ?? null,
    metadata: row.metadata ?? null,
  };
}

/** `prefix%` as a LIKE pattern, its own wildcards escaped. */
export function prefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** jsonb `left || right` for a right-hand object, as Postgres computes it. */
export function jsonbConcat(left: unknown, right: Record<string, unknown>): unknown {
  if (typeof left === 'object' && left !== null && !Array.isArray(left)) {
    return { ...left, ...right };
  }
  if (Array.isArray(left)) return [...left, right];
  return [left, right];
}

export function sealedGrantFromRow(row: {
  provider: string;
  provider_account_id: string;
  subject: string | null;
  display_name: string;
  requested_scopes: string[] | null;
  granted_scopes: string[] | null;
  metadata: unknown;
  client_id: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  expires_at: Date;
}): ProviderGrantSealedRecord {
  return {
    ...grantSummaryFromRow(row),
    clientId: row.client_id,
    encryptedAccessToken: row.encrypted_access_token,
    encryptedRefreshToken: row.encrypted_refresh_token,
    expiresAt: new Date(row.expires_at),
  };
}

/** The row a (re)connect inserts. */
export function sealedGrantValues(provider: string, grant: ProviderGrantSealedInput, now: Date) {
  return {
    provider,
    provider_account_id: grant.accountId,
    client_id: grant.clientId,
    display_name: grant.displayName,
    subject: grant.subject,
    encrypted_access_token: grant.encryptedAccessToken,
    encrypted_refresh_token: grant.encryptedRefreshToken,
    expires_at: grant.expiresAt,
    requested_scopes: grant.requestedScopes,
    granted_scopes: grant.grantedScopes,
    metadata: JSON.stringify(grant.metadata),
    created_at: now,
    updated_at: now,
  };
}
