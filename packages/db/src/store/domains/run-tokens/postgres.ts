import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { runTokenFromRow, runTokenValues } from './record';
import type { RunTokenStore } from './types';

export function postgresRunTokens(db: () => Kysely<DB>): RunTokenStore {
  return {
    async ensureClient(client) {
      await db()
        .insertInto('oauth_clients')
        .values({
          client_id: client.clientId,
          client_name: client.clientName,
          client_secret_hash: client.secretHash,
          redirect_uris: [],
        })
        .onConflict((oc) => oc.column('client_id').doNothing())
        .execute();
    },
    async insert(token) {
      await db().insertInto('oauth_access_tokens').values(runTokenValues(token)).execute();
    },
    async delete(tokenHash) {
      const result = await db()
        .deleteFrom('oauth_access_tokens')
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async find(tokenHash) {
      const row = await db()
        .selectFrom('oauth_access_tokens')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      return row ? runTokenFromRow(row) : null;
    },
  };
}
