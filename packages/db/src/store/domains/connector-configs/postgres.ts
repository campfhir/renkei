import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { connectorConfigFromRow } from './record';
import type { ConnectorConfigStore } from './types';

export function postgresConnectorConfigs(db: () => Kysely<DB>): ConnectorConfigStore {
  return {
    async get(connector) {
      const row = await db()
        .selectFrom('connector_configs')
        .selectAll()
        .where('connector', '=', connector)
        .executeTakeFirst();
      return row ? connectorConfigFromRow(row) : null;
    },
    async list({ enabledOnly = false } = {}) {
      let query = db().selectFrom('connector_configs').selectAll().orderBy('connector');
      if (enabledOnly) query = query.where('enabled', '=', true);
      return (await query.execute()).map(connectorConfigFromRow);
    },
    async upsert({ connector, enabled, settings, encryptedSecrets }) {
      const json = JSON.stringify(settings);
      await db()
        .insertInto('connector_configs')
        .values({
          connector,
          enabled,
          settings: json,
          encrypted_secrets: encryptedSecrets,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['connector']).doUpdateSet({
            enabled,
            settings: json,
            encrypted_secrets: encryptedSecrets,
            updated_at: new Date().toISOString(),
          })
        )
        .execute();
    },
  };
}
