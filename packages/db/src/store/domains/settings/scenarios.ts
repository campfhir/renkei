import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const fixture = {
  settings: [
    { key: 'read_only', value: true },
    { key: 'disabled_connectors', value: ['zoom'] },
    { key: 'organization_name', value: 'Acme' },
  ],
};

export const settingScenarios: Scenario<DataStore>[] = [
  {
    method: 'settings.all',
    name: 'every key, ordered',
    fixture,
    run: async (store) => [...(await store.settings.all())],
  },
  {
    method: 'settings.get',
    name: 'one key, and an unset one',
    fixture,
    run: async (store) => [
      await store.settings.get('disabled_connectors'),
      await store.settings.get('nope'),
    ],
  },
  {
    method: 'settings.set',
    name: 'inserts and replaces',
    fixture,
    run: async (store) => {
      await store.settings.set('read_only', { nested: { n: 3 } });
      await store.settings.set('fresh', 'value');
      return [...(await store.settings.all())];
    },
  },
];
