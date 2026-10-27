import { like, orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { grantSummaryFromRow, jsonbConcat, prefixPattern } from './record';
import type { ProviderGrantStore } from './types';

export function memoryProviderGrants(tables: MemoryTables): ProviderGrantStore {
  return {
    async listForSubject(subject, { provider, providerPrefix } = {}) {
      const pattern = providerPrefix === undefined ? null : prefixPattern(providerPrefix);
      const rows = tables.select(
        'provider_grants',
        (r) =>
          r.subject === subject &&
          (provider === undefined || r.provider === provider) &&
          (pattern === null || like(r.provider, pattern, true))
      );
      return orderBy(rows, [(r) => r.provider], [(r) => r.provider_account_id]).map(
        grantSummaryFromRow
      );
    },
    async deleteForProvider(provider) {
      return tables.delete('provider_grants', (r) => r.provider === provider).length;
    },
    async mergeMetadata(provider, accountId, patch) {
      return tables.update(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId,
        (r) => ({
          metadata: JSON.stringify(jsonbConcat(r.metadata, patch)),
          updated_at: new Date(),
        })
      ).length;
    },
    async getByAccount(provider, accountId) {
      const row = tables.first(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId
      );
      return row ? grantSummaryFromRow(row) : null;
    },
    async disconnectWithTokens(provider, subject) {
      const gone = tables.delete(
        'provider_grants',
        (r) => r.provider === provider && r.subject === subject
      ).length;
      tables.delete('oauth_access_tokens', (r) => r.subject === subject);
      tables.delete('oauth_refresh_tokens', (r) => r.subject === subject);
      return gone;
    },
  };
}
