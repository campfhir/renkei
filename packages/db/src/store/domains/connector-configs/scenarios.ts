import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { ConnectorConfigRecord } from './types';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const fixture = {
  connector_configs: [
    {
      connector: 'zoom',
      enabled: true,
      settings: JSON.stringify({ scopes: 'a b', nested: { n: [1, 2] } }),
      encrypted_secrets: 'sealed-zoom',
      created_at: at(1),
      updated_at: at(2),
    },
    {
      connector: 'atlassian',
      enabled: false,
      settings: JSON.stringify({}),
      encrypted_secrets: 'sealed-atl',
      created_at: at(3),
      updated_at: at(3),
    },
    {
      connector: 'Github',
      enabled: true,
      encrypted_secrets: 'sealed-gh',
      created_at: at(4),
      updated_at: at(4),
    },
  ],
};

/** What a write's answer may show: not the timestamps now() picked. */
function stable(record: ConnectorConfigRecord | null) {
  if (!record) return null;
  const { createdAt: _c, updatedAt: _u, ...rest } = record;
  return rest;
}

export const connectorConfigScenarios: Scenario<DataStore>[] = [
  {
    method: 'connectorConfigs.get',
    name: 'one row with parsed settings, or null',
    fixture,
    run: async (store) => [
      await store.connectorConfigs.get('zoom'),
      await store.connectorConfigs.get('Github'),
      await store.connectorConfigs.get('github'),
      await store.connectorConfigs.get('nobody'),
    ],
  },
  {
    method: 'connectorConfigs.list',
    name: 'by connector key under collation, all or enabled only',
    fixture,
    run: async (store) => [
      await store.connectorConfigs.list(),
      (await store.connectorConfigs.list({ enabledOnly: true })).map((c) => c.connector),
    ],
  },
  {
    method: 'connectorConfigs.list',
    name: 'empty',
    run: async (store) => store.connectorConfigs.list({ enabledOnly: true }),
  },
  {
    method: 'connectorConfigs.upsert',
    name: 'inserts, then replaces keeping created_at',
    fixture,
    run: async (store) => {
      await store.connectorConfigs.upsert({
        connector: 'webex',
        enabled: true,
        settings: { scopes: 'spark:all' },
        encryptedSecrets: 'sealed-webex',
      });
      const inserted = stable(await store.connectorConfigs.get('webex'));
      await store.connectorConfigs.upsert({
        connector: 'zoom',
        enabled: false,
        settings: { scopes: 'only' },
        encryptedSecrets: 'sealed-zoom-2',
      });
      const replaced = await store.connectorConfigs.get('zoom');
      return {
        inserted,
        replaced: stable(replaced),
        createdKept: replaced?.createdAt.toISOString(),
        names: (await store.connectorConfigs.list()).map((c) => c.connector),
      };
    },
  },
];
