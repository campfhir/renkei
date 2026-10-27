import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { FirstRunStore } from './types';

export function postgresFirstRun(db: () => Kysely<DB>): FirstRunStore {
  return {
    async identityProviderConfigured() {
      const row = await db().selectFrom('oidc_config').select('client_id').executeTakeFirst();
      return Boolean(row);
    },
  };
}
