import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import {
  authorizationCodeFromRow,
  clientFromRow,
  clientValues,
  codeValues,
  pendingSigninValues,
  requestFromRow,
  requestValues,
} from './record';
import type { OAuthConsentStore } from './types';

export function postgresOAuthConsents(db: () => Kysely<DB>): OAuthConsentStore {
  return {
    async getClient(clientId) {
      const row = await db()
        .selectFrom('oauth_clients')
        .selectAll()
        .where('client_id', '=', clientId)
        .executeTakeFirst();
      return row ? clientFromRow(row) : null;
    },
    async sweepExpired(now) {
      const result = await db()
        .deleteFrom('oauth_consent_requests')
        .where('expires_at', '<', now)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async createRequest(request) {
      await db().insertInto('oauth_consent_requests').values(requestValues(request)).execute();
    },
    async getRequest(id) {
      const row = await db()
        .selectFrom('oauth_consent_requests as r')
        .innerJoin('oauth_clients as c', 'c.client_id', 'r.client_id')
        .selectAll('r')
        .select(['c.client_name', 'c.created_at as client_created_at'])
        .where('r.id', '=', id)
        .executeTakeFirst();
      if (!row) return null;
      const { client_name, client_created_at, ...request } = row;
      return {
        ...requestFromRow(request),
        clientName: client_name,
        clientCreatedAt: new Date(client_created_at),
      };
    },
    async takeRequest(id) {
      const row = await db()
        .deleteFrom('oauth_consent_requests')
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? requestFromRow(row) : null;
    },
    async insertAuthorizationCode(code) {
      await db().insertInto('oauth_authorization_codes').values(codeValues(code)).execute();
    },
    async getClientCredentials(clientId) {
      const row = await db()
        .selectFrom('oauth_clients')
        .select(['client_id', 'client_secret_hash'])
        .where('client_id', '=', clientId)
        .executeTakeFirst();
      return row ? { clientId: row.client_id, secretHash: row.client_secret_hash ?? null } : null;
    },
    async registerClient(client) {
      await db().insertInto('oauth_clients').values(clientValues(client)).execute();
    },
    async getAuthorizationCode(code) {
      const row = await db()
        .selectFrom('oauth_authorization_codes')
        .selectAll()
        .where('code', '=', code)
        .executeTakeFirst();
      return row ? authorizationCodeFromRow(row) : null;
    },
    async deleteAuthorizationCode(code) {
      const result = await db()
        .deleteFrom('oauth_authorization_codes')
        .where('code', '=', code)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async createPendingSignin(signin) {
      await db().insertInto('pending_oidc_signin').values(pendingSigninValues(signin)).execute();
    },
  };
}
