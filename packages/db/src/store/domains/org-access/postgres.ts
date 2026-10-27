import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { GRANT_COLUMNS, grantFromRow } from './record';
import type { OrgAccessStore } from './types';

export function postgresOrgAccess(db: () => Kysely<DB>): OrgAccessStore {
  const grants = () =>
    db()
      .selectFrom('provider_grants')
      .select(GRANT_COLUMNS)
      .orderBy('provider')
      .orderBy('provider_account_id');
  return {
    async listGrants() {
      return (await grants().execute()).map(grantFromRow);
    },
    async listGrantsOfProviders(providers) {
      if (providers.length === 0) return [];
      return (await grants().where('provider', 'in', providers).execute()).map(grantFromRow);
    },
    async grantsForAccounts(accountIds) {
      if (accountIds.length === 0) return [];
      return (await grants().where('provider_account_id', 'in', accountIds).execute()).map(
        grantFromRow
      );
    },
    async firstGrantOf(subject) {
      const row = await grants().where('subject', '=', subject).executeTakeFirst();
      return row ? grantFromRow(row) : null;
    },
    async revokeGrant(provider, accountId) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const row = await trx
            .deleteFrom('provider_grants')
            .where('provider_account_id', '=', accountId)
            .where('provider', '=', provider)
            .returning(GRANT_COLUMNS)
            .executeTakeFirst();
          if (!row) return null;
          // The subject's MCP bearer credentials go with the grant.
          if (row.subject) {
            await trx
              .deleteFrom('oauth_access_tokens')
              .where('subject', '=', row.subject)
              .execute();
            await trx
              .deleteFrom('oauth_refresh_tokens')
              .where('subject', '=', row.subject)
              .execute();
          }
          return grantFromRow(row);
        });
    },
    async listKeyHolders() {
      return db()
        .selectFrom('user_encryption_keys')
        .select(['subject', 'mode'])
        .orderBy('subject')
        .execute();
    },
    async listContentWatches() {
      const rows = await db()
        .selectFrom('content_watches')
        .select(['provider', 'scope_type', 'scope_label', 'scope_key', 'enabled', 'sync_status'])
        .orderBy('provider')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        provider: row.provider,
        scopeType: row.scope_type,
        scopeLabel: row.scope_label,
        scopeKey: row.scope_key,
        enabled: row.enabled,
        syncStatus: row.sync_status,
      }));
    },
  };
}
