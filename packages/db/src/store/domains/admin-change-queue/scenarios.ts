import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-ac${String(n).padStart(10, '0')}`;
const EXPIRES = '2099-01-01T00:00:00.000Z';
const OPERATOR = 'renkei-operator';

const fixture = {
  sessions: [
    { id: id(11), subject: 'grace', roles: ['renkei-user', OPERATOR], expires_at: EXPIRES },
    { id: id(12), subject: 'ada', roles: [OPERATOR], expires_at: EXPIRES },
    { id: id(13), subject: 'ada', roles: [OPERATOR], expires_at: EXPIRES },
    { id: id(14), subject: 'bob', roles: ['renkei-user'], expires_at: EXPIRES },
  ],
  oauth_clients: [
    { client_id: 'c1', client_secret_hash: 'x', redirect_uris: ['https://x.test/cb'] },
  ],
  oauth_access_tokens: [
    {
      token_hash: 'h1',
      client_id: 'c1',
      subject: 'Zed',
      roles: [OPERATOR],
      expires_at: EXPIRES,
    },
    { token_hash: 'h2', client_id: 'c1', subject: 'ada', roles: [OPERATOR], expires_at: EXPIRES },
    { token_hash: 'h3', client_id: 'c1', subject: 'cy', roles: [], expires_at: EXPIRES },
  ],
  // tools given as JSON text: a JS array would go to Postgres as an array literal.
  agents: [{ id: id(1), owner_subject: 'ada', name: 'Builder', tools: JSON.stringify([]) }],
};

export const adminChangeQueueScenarios: Scenario<DataStore>[] = [
  {
    method: 'adminChangeQueue.operatorSubjects',
    name: 'sessions and tokens holding the role, once each, by subject',
    fixture,
    run: async (store) => [
      await store.adminChangeQueue.operatorSubjects(OPERATOR),
      await store.adminChangeQueue.operatorSubjects('renkei-user'),
      await store.adminChangeQueue.operatorSubjects('nobody'),
    ],
  },
  {
    method: 'adminChangeQueue.recordNotice',
    name: 'lands unread in the person’s feed; a duplicate id is refused',
    run: async (store) => {
      const notice = {
        id: id(5),
        subject: 'ada',
        kind: 'change_request',
        connector: 'jira-admin',
        entity: 'change request',
        headline: 'A Jira change is waiting',
        refId: id(6),
        refUrl: `/jira-admin/changes/${id(6)}`,
      };
      await store.adminChangeQueue.recordNotice(notice);
      const again = await store.adminChangeQueue.recordNotice(notice).then(
        () => 'accepted',
        () => 'refused'
      );
      const feed = await store.notifications.list('ada', { limit: 5 });
      return {
        again,
        feed: feed.map(({ createdAt: _c, ...rest }) => rest),
        unread: await store.notifications.countUnread('ada'),
      };
    },
  },
  {
    method: 'adminChangeQueue.agentName',
    name: 'the agent’s name, or null',
    fixture,
    run: async (store) => [
      await store.adminChangeQueue.agentName(id(1)),
      await store.adminChangeQueue.agentName(id(2)),
      await store.adminChangeQueue.agentName('bad').then(
        () => 'accepted',
        () => 'refused'
      ),
    ],
  },
];
