import type { Kysely } from 'kysely';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import type { DB } from '../../../db.types';
import type { ActivityLogStore } from './types';

export function postgresActivityLogs(db: () => Kysely<DB>): ActivityLogStore {
  return {
    async search(options, cipher) {
      const result = await new PostgresAdapter({
        db: db(),
        ...(cipher ? { encrypt: cipher.encrypt, decrypt: cipher.decrypt } : {}),
      }).query(options);
      if (!result.ok) throw new Error(result.err.message || 'Failed to query logs');
      return result.val;
    },
    async grantNamesByAccountIds(accountIds) {
      if (accountIds.length === 0) return [];
      const rows = await db()
        .selectFrom('provider_grants')
        .select(['provider_account_id', 'display_name'])
        .where('provider_account_id', 'in', accountIds)
        .orderBy('provider_account_id')
        .orderBy('provider')
        .execute();
      return rows.map((row) => ({
        providerAccountId: row.provider_account_id,
        displayName: row.display_name,
      }));
    },
  };
}
