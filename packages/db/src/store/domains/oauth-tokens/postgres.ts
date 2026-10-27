import type { Kysely, Selectable } from 'kysely';
import type { DB, OauthAccessTokens } from '../../../db.types';
import type { OAuthAccessTokenRecord, OAuthTokenStore } from './types';

export function accessTokenFromRow(row: Selectable<OauthAccessTokens>): OAuthAccessTokenRecord {
  return {
    tokenHash: row.token_hash,
    subject: row.subject,
    clientId: row.client_id,
    scope: row.scope,
    application: row.application,
    agentId: row.agent_id,
    roles: row.roles ?? [],
    toolNames: row.tool_names ?? null,
    expiresAt: new Date(row.expires_at),
  };
}

export function postgresOAuthTokens(db: () => Kysely<DB>): OAuthTokenStore {
  return {
    async insertAccessToken(token) {
      await db()
        .insertInto('oauth_access_tokens')
        .values({
          token_hash: token.tokenHash,
          client_id: token.clientId,
          subject: token.subject,
          application: token.application,
          scope: token.scope,
          roles: token.roles,
          expires_at: token.expiresAt,
        })
        .execute();
    },
    async findAccessToken(tokenHash, application) {
      const row = await db()
        .selectFrom('oauth_access_tokens')
        .selectAll()
        .where('token_hash', '=', tokenHash)
        .where('application', '=', application)
        .executeTakeFirst();
      return row ? accessTokenFromRow(row) : null;
    },
    async deleteAccessToken(tokenHash) {
      const result = await db()
        .deleteFrom('oauth_access_tokens')
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async insertRefreshToken(token) {
      await db()
        .insertInto('oauth_refresh_tokens')
        .values({
          token_id: token.tokenId,
          client_id: token.clientId,
          subject: token.subject,
          scope: token.scope,
          roles: token.roles,
          token_hash: token.tokenHash,
          expires_at: token.expiresAt,
        })
        .execute();
    },
    async rotateRefreshToken({ presentedHash, clientId, now, next, access }) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const token = await trx
            .selectFrom('oauth_refresh_tokens')
            .selectAll()
            .where('token_hash', '=', presentedHash)
            .forUpdate()
            .executeTakeFirst();
          if (!token) return { outcome: 'not_found' } as const;
          if (token.client_id !== clientId) return { outcome: 'client_mismatch' } as const;

          if (now > token.expires_at) {
            await trx
              .deleteFrom('oauth_refresh_tokens')
              .where('family_id', '=', token.family_id)
              .execute();
            return { outcome: 'expired', familyId: token.family_id } as const;
          }

          if (token.rotated_at !== null) {
            await trx
              .deleteFrom('oauth_refresh_tokens')
              .where('family_id', '=', token.family_id)
              .execute();
            await trx
              .deleteFrom('oauth_access_tokens')
              .where('client_id', '=', clientId)
              .where('subject', '=', token.subject)
              .where('application', '=', 'jira')
              .execute();
            return {
              outcome: 'reused',
              subject: token.subject,
              familyId: token.family_id,
            } as const;
          }

          const live = await trx
            .selectFrom('sessions')
            .select('roles')
            .where('subject', '=', token.subject)
            .where('expires_at', '>', now)
            .orderBy('created_at', 'desc')
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
          const roles = live ? live.roles : (token.roles ?? []);

          await trx
            .updateTable('oauth_refresh_tokens')
            .set({ rotated_at: now })
            .where('token_id', '=', token.token_id)
            .execute();
          await trx
            .insertInto('oauth_refresh_tokens')
            .values({
              token_id: next.tokenId,
              client_id: clientId,
              subject: token.subject,
              scope: token.scope,
              roles,
              token_hash: next.tokenHash,
              family_id: token.family_id,
              expires_at: token.expires_at,
            })
            .execute();
          await trx
            .insertInto('oauth_access_tokens')
            .values({
              token_hash: access.tokenHash,
              client_id: clientId,
              subject: token.subject,
              application: 'jira',
              scope: token.scope,
              roles,
              expires_at: access.expiresAt,
            })
            .execute();
          return {
            outcome: 'rotated',
            subject: token.subject,
            scope: token.scope,
            roles,
          } as const;
        });
    },
  };
}
