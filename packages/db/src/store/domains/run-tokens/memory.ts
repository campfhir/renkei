import type { MemoryTables } from '../../memory/tables';
import { runTokenFromRow, runTokenValues } from './record';
import type { RunTokenStore } from './types';

export function memoryRunTokens(tables: MemoryTables): RunTokenStore {
  return {
    async ensureClient(client) {
      tables.upsert(
        'oauth_clients',
        {
          client_id: client.clientId,
          client_name: client.clientName,
          client_secret_hash: client.secretHash,
          redirect_uris: [],
        },
        ['client_id']
      );
    },
    async insert(token) {
      tables.insert('oauth_access_tokens', runTokenValues(token));
    },
    async delete(tokenHash) {
      return tables.delete('oauth_access_tokens', (r) => r.token_hash === tokenHash).length;
    },
    async find(tokenHash) {
      const row = tables.first('oauth_access_tokens', (r) => r.token_hash === tokenHash);
      return row ? runTokenFromRow(row) : null;
    },
  };
}
