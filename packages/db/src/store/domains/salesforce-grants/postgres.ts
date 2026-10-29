import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { SalesforceGrantStore } from './types';

export function postgresSalesforceGrants(db: () => Kysely<DB>): SalesforceGrantStore {
  return {
    async listConnections(subject, provider) {
      const rows = await db()
        .selectFrom('provider_grants')
        .select(['provider_account_id', 'display_name', 'metadata', 'requested_scopes'])
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .orderBy('provider_account_id')
        .execute();
      return rows.map((row) => ({
        providerAccountId: row.provider_account_id,
        displayName: row.display_name,
        metadata: row.metadata ?? null,
        requestedScopes: row.requested_scopes ?? [],
      }));
    },
  };
}
