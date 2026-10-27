import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { PersonalAccountStore } from './types';

export function memoryPersonalAccount(tables: MemoryTables): PersonalAccountStore {
  return {
    async grantScopes(subject, providers) {
      const wanted = new Set(providers);
      const rows = tables.select(
        'provider_grants',
        (r) => r.subject === subject && wanted.has(r.provider)
      );
      return orderBy(rows, [(r) => r.provider], [(r) => r.provider_account_id]).map((row) => ({
        provider: row.provider,
        providerAccountId: row.provider_account_id,
        grantedScopes: row.granted_scopes,
      }));
    },
    async providerAccountId(subject, provider) {
      const rows = tables.select(
        'provider_grants',
        (r) => r.subject === subject && r.provider === provider
      );
      return orderBy(rows, [(r) => r.provider_account_id])[0]?.provider_account_id ?? null;
    },
    async ownedAgentNames(subject) {
      const rows = tables.select('agents', (r) => r.owner_subject === subject);
      return orderBy(rows, [(r) => r.name], [(r) => r.id]).map((row) => ({
        id: row.id,
        name: row.name,
      }));
    },
  };
}
