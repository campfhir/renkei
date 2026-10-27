import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const ID = '11111111-1111-4111-8111-111111111111';
const fixture = {
  sessions: [
    {
      id: ID,
      subject: 'ann@example.test',
      roles: ['renkei-user', 'renkei-operator'],
      expires_at: '2030-01-01T00:00:00.000Z',
      last_used_at: '2029-12-01T00:00:00.000Z',
    },
  ],
};

export const sessionScenarios: Scenario<DataStore>[] = [
  {
    method: 'sessions.find',
    name: 'a stored session, and an unknown id',
    fixture,
    run: async (store) => [
      await store.sessions.find(ID),
      await store.sessions.find('22222222-2222-4222-8222-222222222222'),
    ],
  },
  {
    method: 'sessions.find',
    name: 'an upper-cased id finds the row; a malformed one is refused',
    fixture,
    run: async (store) => [
      await store.sessions.find(ID.toUpperCase()),
      await store.sessions.find('not-a-uuid').then(
        () => 'answered',
        (error: unknown) => (error instanceof Object && 'code' in error ? error.code : 'threw')
      ),
    ],
  },
  {
    method: 'sessions.create',
    name: 'creates one, and refuses its id twice',
    run: async (store) => {
      const session = {
        id: ID,
        subject: 'bob@example.test',
        roles: ['renkei-user'],
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      };
      await store.sessions.create(session);
      const second = await store.sessions.create(session).then(
        () => 'accepted',
        () => 'refused'
      );
      const found = await store.sessions.find(ID);
      return { second, found: found && { ...found, lastUsedAt: undefined } };
    },
  },
  {
    method: 'sessions.touch',
    name: 'moves last use; an unknown id is ignored',
    fixture,
    run: async (store) => {
      await store.sessions.touch(ID, new Date('2029-12-24T00:00:00.000Z'));
      await store.sessions.touch('22222222-2222-4222-8222-222222222222', new Date());
      return store.sessions.find(ID);
    },
  },
  {
    method: 'sessions.delete',
    name: 'deletes one; deleting again is harmless',
    fixture,
    run: async (store) => {
      await store.sessions.delete(ID);
      await store.sessions.delete(ID);
      return store.sessions.find(ID);
    },
  },
];
