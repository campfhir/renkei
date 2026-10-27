import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const fixture = {
  identities: [
    { subject: 's-c', email: 'zed@example.test', display_name: null, idp_groups: ['Ops'] },
    { subject: 's-b', email: 'bea@example.test', display_name: 'bea', idp_groups: ['eng', 'Ops'] },
    { subject: 's-d', email: 'amy@example.test', display_name: null, idp_groups: [] },
    { subject: 's-a', email: 'cal@example.test', display_name: 'Abe', idp_groups: ['admins'] },
  ],
};

export const identityScenarios: Scenario<DataStore>[] = [
  {
    method: 'identities.get',
    name: 'a recorded subject, and a stranger',
    fixture,
    run: async (store) => [await store.identities.get('s-b'), await store.identities.get('nobody')],
  },
  {
    method: 'identities.upsert',
    name: 'inserts a newcomer and replaces an existing one',
    fixture,
    run: async (store) => {
      await store.identities.upsert({
        subject: 's-new',
        email: 'new@example.test',
        displayName: 'New',
        idpGroups: ['g'],
      });
      await store.identities.upsert({
        subject: 's-a',
        email: 'abe@example.test',
        displayName: null,
        idpGroups: [],
      });
      return [await store.identities.get('s-new'), await store.identities.get('s-a')];
    },
  },
  {
    method: 'identities.clearGroups',
    name: 'empties one subject’s groups only',
    fixture,
    run: async (store) => {
      await store.identities.clearGroups('s-b');
      await store.identities.clearGroups('nobody');
      return store.identities.list();
    },
  },
  {
    method: 'identities.list',
    name: 'name then email, nameless last, mixed case',
    fixture,
    run: (store) => store.identities.list(),
  },
  {
    method: 'identities.listBySubjects',
    name: 'known ones among the asked, duplicates once',
    fixture,
    run: async (store) => [
      await store.identities.listBySubjects(['s-d', 'nobody', 's-a', 's-d']),
      await store.identities.listBySubjects([]),
    ],
  },
  {
    method: 'identities.distinctGroups',
    name: 'each group once, collated',
    fixture,
    run: (store) => store.identities.distinctGroups(),
  },
  {
    method: 'identities.subjectByEmail',
    name: 'exact email, the first subject of several; case matters',
    fixture: {
      identities: [
        ...fixture.identities,
        { subject: 's-0', email: 'bea@example.test', display_name: null, idp_groups: [] },
      ],
    },
    run: async (store) => [
      await store.identities.subjectByEmail('bea@example.test'),
      await store.identities.subjectByEmail('zed@example.test'),
      await store.identities.subjectByEmail('ZED@example.test'),
      await store.identities.subjectByEmail('nobody@example.test'),
    ],
  },
];
