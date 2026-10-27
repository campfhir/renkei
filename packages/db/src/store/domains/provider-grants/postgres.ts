import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import {
  grantSummaryFromRow,
  prefixPattern,
  sealedGrantFromRow,
  sealedGrantValues,
} from './record';
import type { ProviderGrantStore } from './types';

const SUMMARY_COLUMNS = [
  'provider',
  'provider_account_id',
  'subject',
  'display_name',
  'requested_scopes',
  'granted_scopes',
  'metadata',
] as const;

export function postgresProviderGrants(db: () => Kysely<DB>): ProviderGrantStore {
  return {
    async listForSubject(subject, { provider, providerPrefix } = {}) {
      let query = db()
        .selectFrom('provider_grants')
        .select([
          'provider',
          'provider_account_id',
          'subject',
          'display_name',
          'requested_scopes',
          'granted_scopes',
          'metadata',
        ])
        .where('subject', '=', subject)
        .orderBy('provider')
        .orderBy('provider_account_id');
      if (provider !== undefined) query = query.where('provider', '=', provider);
      if (providerPrefix !== undefined) {
        query = query.where('provider', 'like', prefixPattern(providerPrefix));
      }
      return (await query.execute()).map(grantSummaryFromRow);
    },
    async deleteForProvider(provider) {
      const result = await db()
        .deleteFrom('provider_grants')
        .where('provider', '=', provider)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async mergeMetadata(provider, accountId, patch) {
      const result = await db()
        .updateTable('provider_grants')
        .set({
          // A jsonb merge, not a read-modify-write: concurrent metadata
          // writers (token refresh re-deriving scopes) must not lose to it.
          metadata: sql`metadata || ${JSON.stringify(patch)}::jsonb`,
          updated_at: sql`NOW()`,
        })
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async find(provider, accountId) {
      const row = await db()
        .selectFrom('provider_grants')
        .select(SUMMARY_COLUMNS)
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      return row ? grantSummaryFromRow(row) : null;
    },
    async latestOf(providers, { subject } = {}) {
      if (providers.length === 0) return null;
      let query = db()
        .selectFrom('provider_grants')
        .select(SUMMARY_COLUMNS)
        .where('provider', 'in', providers)
        .orderBy('updated_at', 'desc')
        .orderBy('provider')
        .orderBy('provider_account_id');
      if (subject !== undefined) query = query.where('subject', '=', subject);
      const row = await query.executeTakeFirst();
      return row ? grantSummaryFromRow(row) : null;
    },
    async disconnectWithMcpTokens(provider, subject) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const grants = await trx
            .deleteFrom('provider_grants')
            .where('provider', '=', provider)
            .where('subject', '=', subject)
            .executeTakeFirst();
          const accessTokens = await trx
            .deleteFrom('oauth_access_tokens')
            .where('subject', '=', subject)
            .executeTakeFirst();
          const refreshTokens = await trx
            .deleteFrom('oauth_refresh_tokens')
            .where('subject', '=', subject)
            .executeTakeFirst();
          return {
            grants: Number(grants.numDeletedRows ?? 0),
            accessTokens: Number(accessTokens.numDeletedRows ?? 0),
            refreshTokens: Number(refreshTokens.numDeletedRows ?? 0),
          };
        });
    },
    async findSealed(provider, accountId) {
      const row = await db()
        .selectFrom('provider_grants')
        .select([
          'provider',
          'provider_account_id',
          'subject',
          'display_name',
          'requested_scopes',
          'granted_scopes',
          'metadata',
          'client_id',
          'encrypted_access_token',
          'encrypted_refresh_token',
          'expires_at',
        ])
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      return row ? sealedGrantFromRow(row) : null;
    },
    async upsertSealed(provider, grant) {
      const now = new Date();
      const values = sealedGrantValues(provider, grant, now);
      await db()
        .insertInto('provider_grants')
        .values(values)
        .onConflict((oc) =>
          oc.columns(['provider', 'provider_account_id']).doUpdateSet({
            encrypted_access_token: values.encrypted_access_token,
            encrypted_refresh_token: grant.keepStoredRefreshToken
              ? sql`provider_grants.encrypted_refresh_token`
              : values.encrypted_refresh_token,
            expires_at: values.expires_at,
            requested_scopes: values.requested_scopes,
            granted_scopes: values.granted_scopes,
            metadata: values.metadata,
            updated_at: now,
            subject: values.subject,
          })
        )
        .execute();
    },
    async updateSealedTokens(provider, accountId, tokens) {
      const result = await db()
        .updateTable('provider_grants')
        .set({
          encrypted_access_token: tokens.encryptedAccessToken,
          encrypted_refresh_token: tokens.encryptedRefreshToken,
          expires_at: tokens.expiresAt,
          updated_at: new Date(),
          ...(tokens.grantedScopes ? { granted_scopes: tokens.grantedScopes } : {}),
        })
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async delete(provider, accountId) {
      const result = await db()
        .deleteFrom('provider_grants')
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async acquireRefreshLock(provider, accountId, at) {
      const inserted = await db()
        .insertInto('provider_refresh_locks')
        .values({ provider, account_id: accountId, locked_at: at })
        .onConflict((oc) => oc.doNothing())
        .returning('provider')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async findRefreshLock(provider, accountId) {
      const row = await db()
        .selectFrom('provider_refresh_locks')
        .select('locked_at')
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return row ? row.locked_at : null;
    },
    async releaseRefreshLock(provider, accountId) {
      await db()
        .deleteFrom('provider_refresh_locks')
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .execute();
    },
    async findByAccount(accountId) {
      const row = await db()
        .selectFrom('provider_grants')
        .select(SUMMARY_COLUMNS)
        .where('provider_account_id', '=', accountId)
        .orderBy('provider')
        .executeTakeFirst();
      return row ? grantSummaryFromRow(row) : null;
    },
    async findByMetadataText(provider, key, value) {
      const row = await db()
        .selectFrom('provider_grants')
        .select(SUMMARY_COLUMNS)
        .where('provider', '=', provider)
        .where(sql<string>`metadata->>${key}`, '=', value)
        .orderBy('provider_account_id')
        .executeTakeFirst();
      return row ? grantSummaryFromRow(row) : null;
    },
    async findByHolderEmail(provider, email) {
      const row = await db()
        .selectFrom('identities')
        .innerJoin('provider_grants', (join) =>
          join.onRef('provider_grants.subject', '=', 'identities.subject')
        )
        .select([
          'provider_grants.provider',
          'provider_grants.provider_account_id',
          'provider_grants.subject',
          'provider_grants.display_name',
          'provider_grants.requested_scopes',
          'provider_grants.granted_scopes',
          'provider_grants.metadata',
        ])
        .where('identities.email', '=', email)
        .where('provider_grants.provider', '=', provider)
        .orderBy('provider_grants.provider_account_id')
        .limit(1)
        .executeTakeFirst();
      return row ? grantSummaryFromRow(row) : null;
    },
  };
}
