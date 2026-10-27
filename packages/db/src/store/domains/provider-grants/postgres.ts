import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { grantSummaryFromRow, prefixPattern } from './record';
import type { ProviderGrantStore } from './types';

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
    async getByAccount(provider, accountId) {
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
        ])
        .where('provider', '=', provider)
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      return row ? grantSummaryFromRow(row) : null;
    },
    async disconnectWithTokens(provider, subject) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const result = await trx
            .deleteFrom('provider_grants')
            .where('provider', '=', provider)
            .where('subject', '=', subject)
            .executeTakeFirst();
          await trx.deleteFrom('oauth_access_tokens').where('subject', '=', subject).execute();
          await trx.deleteFrom('oauth_refresh_tokens').where('subject', '=', subject).execute();
          return Number(result.numDeletedRows ?? 0);
        });
    },
  };
}
