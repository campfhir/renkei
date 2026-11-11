import type { MemoryTables } from '../../memory/tables';
import {
  authorizationCodeFromRow,
  clientFromRow,
  clientValues,
  codeValues,
  requestFromRow,
  requestValues,
} from './record';
import type { OAuthConsentStore } from './types';

export function memoryOAuthConsents(tables: MemoryTables): OAuthConsentStore {
  return {
    async getClient(clientId) {
      const row = tables.first('oauth_clients', (r) => r.client_id === clientId);
      return row ? clientFromRow(row) : null;
    },
    async sweepExpired(now) {
      return tables.delete('oauth_consent_requests', (r) => r.expires_at.getTime() < now.getTime())
        .length;
    },
    async createRequest(request) {
      tables.insert('oauth_consent_requests', {
        ...requestValues(request),
        created_at: new Date(),
      });
    },
    async getRequest(id) {
      const key = id;
      const row = tables.first('oauth_consent_requests', (r) => r.id === key);
      if (!row) return null;
      const client = tables.first('oauth_clients', (c) => c.client_id === row.client_id);
      if (!client) return null;
      return {
        ...requestFromRow(row),
        clientName: client.client_name,
        clientCreatedAt: new Date(client.created_at),
      };
    },
    async takeRequest(id) {
      const key = id;
      const [row] = tables.delete('oauth_consent_requests', (r) => r.id === key);
      return row ? requestFromRow(row) : null;
    },
    async insertAuthorizationCode(code) {
      tables.insert('oauth_authorization_codes', { ...codeValues(code), created_at: new Date() });
    },
    async registerClient(client) {
      const now = new Date();
      tables.insert('oauth_clients', { ...clientValues(client), created_at: now, updated_at: now });
    },
    async getClientCredentials(clientId) {
      const row = tables.first('oauth_clients', (r) => r.client_id === clientId);
      return row ? { clientId: row.client_id, secretHash: row.client_secret_hash ?? null } : null;
    },
    async getAuthorizationCode(code) {
      const row = tables.first('oauth_authorization_codes', (r) => r.code === code);
      return row ? authorizationCodeFromRow(row) : null;
    },
    async deleteAuthorizationCode(code) {
      return tables.delete('oauth_authorization_codes', (r) => r.code === code).length;
    },
    async takeAuthorizationCode(code) {
      const [row] = tables.delete('oauth_authorization_codes', (r) => r.code === code);
      return row ? authorizationCodeFromRow(row) : null;
    },
  };
}
