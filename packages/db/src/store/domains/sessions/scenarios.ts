import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const ID = '11111111-1111-4111-8111-111111111111';
const fixture = {
  sessions: [
    {
      id: ID,
      subject: 'ann@example.test',
      roles: ['renkei-user', 'renkei-operator'],
      expires_at: new Date('2030-01-01T00:00:00.000Z'),
      last_used_at: new Date('2029-12-01T00:00:00.000Z'),
    },
  ],
};

const sid = (n: number) => `00000000-0000-4000-8000-5e${String(n).padStart(10, '0')}`;
const session = (n: number, subject: string, lastUsed: Date) => ({
  id: sid(n),
  subject,
  expires_at: new Date('2030-01-01T00:00:00.000Z'),
  last_used_at: lastUsed,
});
const subjectFixture = {
  sessions: [
    session(1, 'ann', new Date('2029-12-01T00:00:00.000Z')),
    session(2, 'ann', new Date('2029-12-03T00:00:00.000Z')),
    session(3, 'bob', new Date('2029-11-01T00:00:00.000Z')),
    session(4, 'cy', new Date('2029-12-09T00:00:00.000Z')),
  ],
  oauth_clients: [
    { client_id: 'client-1', client_secret_hash: 'h', redirect_uris: ['https://x.test'] },
  ],
  oauth_access_tokens: [
    {
      token_hash: 'a1',
      client_id: 'client-1',
      subject: 'ann',
      expires_at: new Date('2030-01-01T00:00:00Z'),
    },
    {
      token_hash: 'a2',
      client_id: 'client-1',
      subject: 'ann',
      expires_at: new Date('2030-01-01T00:00:00Z'),
    },
    {
      token_hash: 'a3',
      client_id: 'client-1',
      subject: 'bob',
      expires_at: new Date('2030-01-01T00:00:00Z'),
    },
  ],
  oauth_refresh_tokens: [
    {
      token_hash: 'r1',
      token_id: '00000000-0000-4000-8000-5f0000000001',
      client_id: 'client-1',
      subject: 'ann',
      expires_at: new Date('2030-01-01T00:00:00Z'),
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
    method: 'sessions.create',
    name: 'creates one, readable after',
    run: async (store) => {
      const session = {
        id: ID,
        subject: 'bob@example.test',
        roles: ['renkei-user'],
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      };
      await store.sessions.create(session);
      const found = await store.sessions.find(ID);
      return { found: found && { ...found, lastUsedAt: undefined } };
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
  {
    method: 'sessions.lastUsedBySubject',
    name: 'newest use per subject, by subject; none at all',
    fixture: subjectFixture,
    run: async (store) => store.sessions.lastUsedBySubject(),
  },
  {
    method: 'sessions.lastUsedBySubject',
    name: 'no sessions',
    run: async (store) => store.sessions.lastUsedBySubject(),
  },
  {
    method: 'sessions.lastUsedOf',
    name: 'newest of several, and a subject with none',
    fixture: subjectFixture,
    run: async (store) => [
      await store.sessions.lastUsedOf('ann'),
      await store.sessions.lastUsedOf('cy'),
      await store.sessions.lastUsedOf('nobody'),
    ],
  },
  {
    method: 'sessions.deleteForSubject',
    name: 'every session of one subject, nobody else’s',
    fixture: subjectFixture,
    run: async (store) => [
      await store.sessions.deleteForSubject('ann'),
      await store.sessions.deleteForSubject('ann'),
      await store.sessions.lastUsedBySubject(),
    ],
  },
  {
    method: 'sessions.revokeAll',
    name: 'sessions and both token kinds, one subject only',
    fixture: subjectFixture,
    run: async (store) => [
      await store.sessions.revokeAll('ann'),
      await store.sessions.revokeAll('ann'),
      await store.sessions.revokeAll('bob'),
      await store.sessions.lastUsedBySubject(),
    ],
  },
  {
    method: 'sessions.latestRolesOf',
    name: "the most recently used session's roles, or null",
    fixture: {
      sessions: [
        { ...session(1, 'ann', new Date('2029-12-01T00:00:00.000Z')), roles: ['old'] },
        { ...session(2, 'ann', new Date('2029-12-03T00:00:00.000Z')), roles: ['new', 'x'] },
        { ...session(3, 'bob', new Date('2029-12-03T00:00:00.000Z')), roles: ['b2'] },
        { ...session(4, 'bob', new Date('2029-12-03T00:00:00.000Z')), roles: ['b4'] },
      ],
    },
    run: async (store) => [
      await store.sessions.latestRolesOf('ann'),
      await store.sessions.latestRolesOf('bob'),
      await store.sessions.latestRolesOf('nobody'),
    ],
  },
];
