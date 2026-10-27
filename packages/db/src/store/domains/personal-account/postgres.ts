import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { PersonalAccountStore } from './types';

export function postgresPersonalAccount(db: () => Kysely<DB>): PersonalAccountStore {
  return {
    async grantScopes(subject, providers) {
      if (providers.length === 0) return [];
      const rows = await db()
        .selectFrom('provider_grants')
        .select(['provider', 'provider_account_id', 'granted_scopes'])
        .where('subject', '=', subject)
        .where('provider', 'in', providers)
        .orderBy('provider')
        .orderBy('provider_account_id')
        .execute();
      return rows.map((row) => ({
        provider: row.provider,
        providerAccountId: row.provider_account_id,
        grantedScopes: row.granted_scopes,
      }));
    },
    async providerAccountId(subject, provider) {
      const row = await db()
        .selectFrom('provider_grants')
        .select('provider_account_id')
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .orderBy('provider_account_id')
        .executeTakeFirst();
      return row?.provider_account_id ?? null;
    },
    async ownedAgentNames(subject) {
      return db()
        .selectFrom('agents')
        .select(['id', 'name'])
        .where('owner_subject', '=', subject)
        .orderBy('name')
        .orderBy('id')
        .execute();
    },
  };
}
