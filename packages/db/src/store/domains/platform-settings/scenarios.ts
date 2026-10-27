import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const fixture = {
  platform_settings: [
    { key: 'vapid_keys', value: JSON.stringify({ publicKey: 'pub', encryptedPrivateKey: 'enc' }) },
    { key: 'flag', value: JSON.stringify(false) },
  ],
};

export const platformSettingScenarios: Scenario<DataStore>[] = [
  {
    method: 'platformSettings.get',
    name: 'stored JSON as it is; a missing key reads null',
    fixture,
    run: async (store) => [
      await store.platformSettings.get('vapid_keys'),
      await store.platformSettings.get('flag'),
      await store.platformSettings.get('missing'),
    ],
  },
  {
    method: 'platformSettings.insertIfAbsent',
    name: 'writes once; the first value stays',
    fixture,
    run: async (store) => [
      await store.platformSettings.insertIfAbsent('fresh', { a: 1 }),
      await store.platformSettings.insertIfAbsent('fresh', { a: 2 }),
      await store.platformSettings.insertIfAbsent('vapid_keys', { publicKey: 'other' }),
      await store.platformSettings.get('fresh'),
      await store.platformSettings.get('vapid_keys'),
    ],
  },
];
