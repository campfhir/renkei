import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { accessTokenFromRow } from './postgres';
import type { OAuthTokenStore } from './types';

/**
 * The rotation is synchronous here, so it is atomic without a lock; a
 * refused write part-way (a duplicate successor digest) can leave the
 * presented token marked rotated, which Postgres's transaction would undo.
 * The successor is inserted before the presented token is marked, so the
 * likely refusals come first.
 */
export function memoryOAuthTokens(tables: MemoryTables): OAuthTokenStore {
  return {
    async insertAccessToken(token) {
      tables.insert('oauth_access_tokens', {
        token_hash: token.tokenHash,
        client_id: token.clientId,
        subject: token.subject,
        application: token.application,
        scope: token.scope,
        roles: token.roles,
        expires_at: token.expiresAt,
      });
    },
    async findAccessToken(tokenHash, application) {
      const row = tables.first(
        'oauth_access_tokens',
        (r) => r.token_hash === tokenHash && r.application === application
      );
      return row ? accessTokenFromRow(row) : null;
    },
    async deleteAccessToken(tokenHash) {
      return tables.delete('oauth_access_tokens', (r) => r.token_hash === tokenHash).length;
    },
    async insertRefreshToken(token) {
      tables.insert('oauth_refresh_tokens', {
        token_id: token.tokenId,
        client_id: token.clientId,
        subject: token.subject,
        scope: token.scope,
        roles: token.roles,
        token_hash: token.tokenHash,
        expires_at: token.expiresAt,
      });
    },
    async rotateRefreshToken({ presentedHash, clientId, now, next, access }) {
      const token = tables.first('oauth_refresh_tokens', (r) => r.token_hash === presentedHash);
      if (!token) return { outcome: 'not_found' };
      if (token.client_id !== clientId) return { outcome: 'client_mismatch' };

      const family = token.family_id;
      if (now.getTime() > token.expires_at.getTime()) {
        tables.delete('oauth_refresh_tokens', (r) => r.family_id === family);
        return { outcome: 'expired', familyId: family };
      }
      if (token.rotated_at !== null) {
        tables.delete('oauth_refresh_tokens', (r) => r.family_id === family);
        tables.delete(
          'oauth_access_tokens',
          (r) => r.client_id === clientId && r.subject === token.subject && r.application === 'jira'
        );
        return { outcome: 'reused', subject: token.subject, familyId: family };
      }

      const [live] = orderBy(
        tables.select(
          'sessions',
          (s) => s.subject === token.subject && s.expires_at.getTime() > now.getTime()
        ),
        [(s) => s.created_at, 'desc'],
        [(s) => s.id, 'desc']
      );
      const roles = live ? live.roles : (token.roles ?? []);

      tables.insert('oauth_refresh_tokens', {
        token_id: next.tokenId,
        client_id: clientId,
        subject: token.subject,
        scope: token.scope,
        roles,
        token_hash: next.tokenHash,
        family_id: family,
        expires_at: token.expires_at,
      });
      tables.insert('oauth_access_tokens', {
        token_hash: access.tokenHash,
        client_id: clientId,
        subject: token.subject,
        application: 'jira',
        scope: token.scope,
        roles,
        expires_at: access.expiresAt,
      });
      tables.update('oauth_refresh_tokens', (r) => r.token_id === token.token_id, {
        rotated_at: now,
      });
      return { outcome: 'rotated', subject: token.subject, scope: token.scope, roles };
    },
  };
}
