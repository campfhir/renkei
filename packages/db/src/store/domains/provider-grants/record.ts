import type { ProviderGrantSummaryRecord } from './types';

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
