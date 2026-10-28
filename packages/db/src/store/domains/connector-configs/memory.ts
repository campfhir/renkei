import { orderBy } from '../../memory/order';
import { toJson, type MemoryTables } from '../../memory/tables';
import { connectorConfigFromRow } from './record';
import type { ConnectorConfigStore } from './types';

export function memoryConnectorConfigs(tables: MemoryTables): ConnectorConfigStore {
  return {
    async get(connector) {
      const row = tables.first('connector_configs', (r) => r.connector === connector);
      return row ? connectorConfigFromRow(row) : null;
    },
    async list({ enabledOnly = false } = {}) {
      const rows = tables.select('connector_configs', (r) => !enabledOnly || r.enabled);
      return orderBy(rows, [(r) => r.connector]).map(connectorConfigFromRow);
    },
    async upsert({ connector, enabled, settings, encryptedSecrets }) {
      const json = toJson(settings);
      const now = new Date();
      tables.upsert(
        'connector_configs',
        {
          connector,
          enabled,
          settings: json,
          encrypted_secrets: encryptedSecrets,
          created_at: now,
          updated_at: now,
        },
        ['connector'],
        { enabled, settings: json, encrypted_secrets: encryptedSecrets, updated_at: now }
      );
    },
  };
}
