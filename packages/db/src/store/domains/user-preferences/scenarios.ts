import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

export const userPreferenceScenarios: Scenario<DataStore>[] = [
  {
    method: 'userPreferences.get',
    name: 'a stored value per subject and key, nothing for the rest',
    fixture: {
      user_preferences: [
        { subject: 'ann', key: 'theme', value: JSON.stringify({ mode: 'dark', n: [1, 'two'] }) },
        { subject: 'bob', key: 'theme', value: JSON.stringify({ mode: 'light' }) },
      ],
    },
    run: async (store) => [
      await store.userPreferences.get('ann', 'theme'),
      await store.userPreferences.get('bob', 'theme'),
      await store.userPreferences.get('ann', 'voice'),
    ],
  },
  {
    method: 'userPreferences.set',
    name: 'stores as a JSON round trip leaves it, replaces on a second set',
    run: async (store) => {
      await store.userPreferences.set('ann', 'k', {
        when: new Date('2026-01-02T03:04:05.000Z'),
        gone: undefined,
        list: [1, null],
      });
      const first = await store.userPreferences.get('ann', 'k');
      await store.userPreferences.set('ann', 'k', 42);
      await store.userPreferences.set('ann', 'arr', ['x', 'y']);
      return [
        first,
        await store.userPreferences.get('ann', 'k'),
        await store.userPreferences.get('ann', 'arr'),
      ];
    },
  },
  {
    method: 'userPreferences.delete',
    name: 'one key of one person; reads as never set after',
    fixture: {
      user_preferences: [
        { subject: 'ann', key: 'chatTools', value: JSON.stringify({ connectors: ['jira'] }) },
        { subject: 'ann', key: 'theme', value: JSON.stringify({ mode: 'dark' }) },
        { subject: 'bob', key: 'chatTools', value: JSON.stringify({ connectors: [] }) },
      ],
    },
    run: async (store) => {
      await store.userPreferences.delete('ann', 'chatTools');
      await store.userPreferences.delete('ann', 'never');
      return [
        await store.userPreferences.get('ann', 'chatTools'),
        await store.userPreferences.get('ann', 'theme'),
        await store.userPreferences.get('bob', 'chatTools'),
      ];
    },
  },
];
