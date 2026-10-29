import { orderBy } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { grantFromRow } from './record';
import type { OrgAccessStore } from './types';

export function memoryOrgAccess(tables: MemoryTables): OrgAccessStore {
  const grants = (where?: (row: Row<'provider_grants'>) => boolean) =>
    orderBy(
      tables.select('provider_grants', where),
      [(r) => r.provider],
      [(r) => r.provider_account_id]
    ).map(grantFromRow);
  return {
    async listGrants() {
      return grants();
    },
    async listGrantsOfProviders(providers) {
      const wanted = new Set(providers);
      return grants((r) => wanted.has(r.provider));
    },
    async grantsForAccounts(accountIds) {
      const wanted = new Set(accountIds);
      return grants((r) => wanted.has(r.provider_account_id));
    },
    async firstGrantOf(subject) {
      return grants((r) => r.subject === subject)[0] ?? null;
    },
    async revokeGrant(provider, accountId) {
      const [row] = tables.delete(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId
      );
      if (!row) return null;
      if (row.subject) {
        const subject = row.subject;
        tables.delete('oauth_access_tokens', (r) => r.subject === subject);
        tables.delete('oauth_refresh_tokens', (r) => r.subject === subject);
      }
      return grantFromRow(row);
    },
    async listKeyHolders() {
      return orderBy(tables.select('user_encryption_keys'), [(r) => r.subject]).map((r) => ({
        subject: r.subject,
        mode: r.mode,
      }));
    },
    async listContentWatches() {
      return orderBy(tables.select('content_watches'), [(r) => r.provider], [(r) => r.id]).map(
        (row) => ({
          provider: row.provider,
          scopeType: row.scope_type,
          scopeLabel: row.scope_label,
          scopeKey: row.scope_key,
          enabled: row.enabled,
          syncStatus: row.sync_status,
        })
      );
    },
  };
}
