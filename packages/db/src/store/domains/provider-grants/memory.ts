import { metadataText } from '../knowledge-chunks/metadata-filter';
import { like, orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import {
  grantSummaryFromRow,
  jsonbConcat,
  prefixPattern,
  sealedGrantFromRow,
  sealedGrantValues,
} from './record';
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
    async find(provider, accountId) {
      const row = tables.first(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId
      );
      return row ? grantSummaryFromRow(row) : null;
    },
    async latestOf(providers, { subject } = {}) {
      const wanted = new Set(providers);
      const rows = tables.select(
        'provider_grants',
        (r) => wanted.has(r.provider) && (subject === undefined || r.subject === subject)
      );
      const [row] = orderBy(
        rows,
        [(r) => r.updated_at, 'desc'],
        [(r) => r.provider],
        [(r) => r.provider_account_id]
      );
      return row ? grantSummaryFromRow(row) : null;
    },
    async disconnectWithMcpTokens(provider, subject) {
      return {
        grants: tables.delete(
          'provider_grants',
          (r) => r.provider === provider && r.subject === subject
        ).length,
        accessTokens: tables.delete('oauth_access_tokens', (r) => r.subject === subject).length,
        refreshTokens: tables.delete('oauth_refresh_tokens', (r) => r.subject === subject).length,
      };
    },
    async findSealed(provider, accountId) {
      const row = tables.first(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId
      );
      return row ? sealedGrantFromRow(row) : null;
    },
    async upsertSealed(provider, grant) {
      const now = new Date();
      const values = sealedGrantValues(provider, grant, now);
      tables.upsert('provider_grants', values, ['provider', 'provider_account_id'], (existing) => ({
        encrypted_access_token: values.encrypted_access_token,
        encrypted_refresh_token: grant.keepStoredRefreshToken
          ? existing.encrypted_refresh_token
          : values.encrypted_refresh_token,
        expires_at: values.expires_at,
        requested_scopes: values.requested_scopes,
        granted_scopes: values.granted_scopes,
        metadata: values.metadata,
        updated_at: now,
        subject: values.subject,
      }));
    },
    async updateSealedTokens(provider, accountId, tokens) {
      return tables.update(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId,
        {
          encrypted_access_token: tokens.encryptedAccessToken,
          encrypted_refresh_token: tokens.encryptedRefreshToken,
          expires_at: tokens.expiresAt,
          updated_at: new Date(),
          ...(tokens.grantedScopes ? { granted_scopes: tokens.grantedScopes } : {}),
        }
      ).length;
    },
    async delete(provider, accountId) {
      return tables.delete(
        'provider_grants',
        (r) => r.provider === provider && r.provider_account_id === accountId
      ).length;
    },
    async acquireRefreshLock(provider, accountId, at) {
      return (
        tables.upsert(
          'provider_refresh_locks',
          { provider, account_id: accountId, locked_at: at },
          ['provider', 'account_id']
        ) !== undefined
      );
    },
    async findRefreshLock(provider, accountId) {
      const row = tables.first(
        'provider_refresh_locks',
        (r) => r.provider === provider && r.account_id === accountId
      );
      return row ? row.locked_at : null;
    },
    async releaseRefreshLock(provider, accountId) {
      tables.delete(
        'provider_refresh_locks',
        (r) => r.provider === provider && r.account_id === accountId
      );
    },
    async findByAccount(accountId) {
      const rows = tables.select('provider_grants', (r) => r.provider_account_id === accountId);
      const [row] = orderBy(rows, [(r) => r.provider]);
      return row ? grantSummaryFromRow(row) : null;
    },
    async findByMetadataText(provider, key, value) {
      const rows = tables.select(
        'provider_grants',
        (r) => r.provider === provider && metadataText(r.metadata, key) === value
      );
      const [row] = orderBy(rows, [(r) => r.provider_account_id]);
      return row ? grantSummaryFromRow(row) : null;
    },
    async findByHolderEmail(provider, email) {
      const holders = new Set(
        tables.select('identities', (r) => r.email === email).map((r) => r.subject)
      );
      const rows = tables.select(
        'provider_grants',
        (r) => r.provider === provider && r.subject !== null && holders.has(r.subject)
      );
      const [row] = orderBy(rows, [(r) => r.provider_account_id]);
      return row ? grantSummaryFromRow(row) : null;
    },
  };
}
