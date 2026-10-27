import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { SalesforceGrantStore } from './types';

export function memorySalesforceGrants(tables: MemoryTables): SalesforceGrantStore {
  return {
    async listConnections(subject, provider) {
      const rows = tables.select(
        'provider_grants',
        (r) => r.provider === provider && r.subject === subject
      );
      return orderBy(rows, [(r) => r.provider_account_id]).map((row) => ({
        providerAccountId: row.provider_account_id,
        displayName: row.display_name,
        metadata: row.metadata ?? null,
        requestedScopes: row.requested_scopes ?? [],
      }));
    },
  };
}
