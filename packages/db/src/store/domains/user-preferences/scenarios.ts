import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

export const userPreferenceScenarios: Scenario<DataStore>[] = [
  {
    method: 'userPreferences.get',
    name: 'a stored value per subject and key, nothing for the rest',
    fixture: {
      user_preferences: [
        { subject: 'ann', key: 'theme', value: { mode: 'dark', n: [1, 'two'] } },
        { subject: 'bob', key: 'theme', value: { mode: 'light' } },
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
    method: 'userPreferences.merge',
    name: 'named fields replace whole, others stay; twice is once; a new or non-object key becomes the patch',
    fixture: {
      user_preferences: [
        { subject: 'ann', key: 'notifications', value: { a: 1, b: { x: true }, c: 'keep' } },
        { subject: 'ann', key: 'list', value: [1, 2] },
        { subject: 'bob', key: 'notifications', value: { a: 9 } },
      ],
    },
    run: async (store) => {
      await store.userPreferences.merge('ann', 'notifications', { a: 2, b: { y: false } });
      const once = await store.userPreferences.get('ann', 'notifications');
      await store.userPreferences.merge('ann', 'notifications', { a: 2, b: { y: false } });
      const twice = await store.userPreferences.get('ann', 'notifications');
      await store.userPreferences.merge('ann', 'notifications', { d: [1, 'two'] });
      await store.userPreferences.merge('ann', 'list', { z: 1 });
      await store.userPreferences.merge('cat', 'notifications', { a: 3 });
      return [
        once,
        twice,
        await store.userPreferences.get('ann', 'notifications'),
        await store.userPreferences.get('ann', 'list'),
        await store.userPreferences.get('cat', 'notifications'),
        await store.userPreferences.get('bob', 'notifications'),
      ];
    },
  },
  {
    method: 'userPreferences.delete',
    name: 'one key of one person; reads as never set after',
    fixture: {
      user_preferences: [
        { subject: 'ann', key: 'chatTools', value: { connectors: ['jira'] } },
        { subject: 'ann', key: 'theme', value: { mode: 'dark' } },
        { subject: 'bob', key: 'chatTools', value: { connectors: [] } },
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
  {
    method: 'userPreferences.listBySubject',
    name: "one person's keys with their values, by key; other people left out",
    fixture: {
      user_preferences: [
        { subject: 'ann', key: 'theme', value: { mode: 'dark' } },
        { subject: 'ann', key: 'chatArchive', value: { afterDays: 30 } },
        { subject: 'ann', key: 'voice', value: ['x', 1] },
        { subject: 'bob', key: 'aaa', value: { mode: 'light' } },
      ],
    },
    run: async (store) => [
      await store.userPreferences.listBySubject('ann'),
      await store.userPreferences.listBySubject('nobody'),
    ],
  },
  {
    method: 'userPreferences.listByKey',
    name: "everyone's value of one key, by subject; other keys left out",
    fixture: {
      user_preferences: [
        { subject: 'cat', key: 'chatArchive', value: { days: 7 } },
        { subject: 'Ann', key: 'chatArchive', value: { days: 30 } },
        { subject: 'bob', key: 'chatArchive', value: false },
        { subject: 'ann', key: 'theme', value: { mode: 'dark' } },
      ],
    },
    run: async (store) => [
      await store.userPreferences.listByKey('chatArchive'),
      await store.userPreferences.listByKey('never'),
    ],
  },
];
