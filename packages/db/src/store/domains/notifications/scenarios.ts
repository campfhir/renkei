import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function row(n: number, subject: string, minute: number, read = false) {
  return {
    id: id(n),
    subject,
    kind: 'agent_run',
    headline: `at ${minute}`,
    connector: n % 2 ? 'jira' : null,
    meta: n === 1 ? JSON.stringify({ counts: { done: 1 } }) : null,
    created_at: at(minute),
    read_at: read ? at(minute + 1) : null,
  };
}

const fixture = {
  agent_notifications: [
    row(1, 'ann', 1),
    row(2, 'ann', 3),
    row(3, 'ann', 2, true),
    row(4, 'ann', 5),
    row(5, 'ann', 4),
    row(6, 'ann', 4),
    row(7, 'bob', 6),
  ],
};

const chat = (n: number) => `00000000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;

const pushFixture = {
  push_subscriptions: [
    {
      id: id(21),
      subject: 'ann',
      endpoint: 'https://push.test/ann-2',
      p256dh: 'p2',
      auth: 'a2',
      created_at: at(1),
    },
    {
      id: id(22),
      subject: 'ann',
      endpoint: 'https://push.test/ann-1',
      p256dh: 'p1',
      auth: 'a1',
      created_at: at(1),
    },
    {
      id: id(23),
      subject: 'ann',
      endpoint: 'https://push.test/ann-0',
      p256dh: 'p0',
      auth: 'a0',
      created_at: at(2),
    },
    {
      id: id(24),
      subject: 'bob',
      endpoint: 'https://push.test/bob-1',
      p256dh: 'pb',
      auth: 'ab',
      created_at: at(1),
    },
  ],
};

const presenceFixture = {
  chats: [
    { id: chat(1), owner_subject: 'ann' },
    { id: chat(2), owner_subject: 'bob' },
  ],
  chat_presence: [
    { subject: 'ann', chat_id: chat(1), updated_at: at(3) },
    { subject: 'bob', chat_id: chat(2), updated_at: at(2) },
  ],
};

export const notificationScenarios: Scenario<DataStore>[] = [
  {
    method: 'notifications.list',
    name: 'newest first, ties by id, bounded and filtered',
    fixture,
    run: async (store) => [
      await store.notifications.list('ann', { limit: 10 }),
      await store.notifications.list('ann', { limit: 2 }),
      await store.notifications.list('ann', { limit: 10, since: new Date(at(3)) }),
      await store.notifications.list('ann', { limit: 10, before: new Date(at(3)) }),
      await store.notifications.list('ann', { limit: 10, unreadOnly: true }),
      await store.notifications.list('nobody', { limit: 10 }),
    ],
  },
  {
    method: 'notifications.countUnread',
    name: 'per person',
    fixture,
    run: async (store) => [
      await store.notifications.countUnread('ann'),
      await store.notifications.countUnread('bob'),
      await store.notifications.countUnread('nobody'),
    ],
  },
  {
    method: 'notifications.mark',
    name: 'read and unread, counting only changes, own rows only',
    fixture,
    run: async (store) => {
      const counts = [
        await store.notifications.mark('ann', { ids: [id(1), id(3), id(7)] }, { unread: false }),
        await store.notifications.mark('ann', { ids: [] }, { unread: false }),
        await store.notifications.mark('ann', { ids: [id(1)] }, { unread: true }),
        await store.notifications.mark('ann', { all: true }, { unread: true }),
      ];
      const unread = await store.notifications.list('ann', { limit: 10, unreadOnly: true });
      return {
        counts,
        unread: unread.map((n) => n.id),
        bob: await store.notifications.countUnread('bob'),
      };
    },
  },
  {
    method: 'notifications.delete',
    name: 'by id or all, own rows only',
    fixture,
    run: async (store) => [
      await store.notifications.delete('ann', { ids: [id(1), id(7)] }),
      await store.notifications.delete('ann', { ids: [] }),
      (await store.notifications.list('ann', { limit: 10 })).map((n) => n.id),
      await store.notifications.delete('ann', { all: true }),
      (await store.notifications.list('bob', { limit: 10 })).map((n) => n.id),
    ],
  },
  {
    method: 'notifications.insert',
    name: 'given time and read state; refuses a duplicate id',
    run: async (store) => {
      const base = {
        id: id(9),
        subject: 'ann',
        kind: 'act',
        category: 'jira',
        connector: null,
        tool: 'create_issue',
        entity: 'ABC-1',
        headline: 'made',
        refUrl: 'https://example.test/ABC-1',
        agentId: null,
        agentName: 'Bot',
        runId: null,
        meta: { a: [1] },
        createdAt: new Date(at(7)),
      };
      await store.notifications.insert(base);
      const again = await store.notifications.insert(base).then(
        () => 'accepted',
        () => 'refused'
      );
      return { again, rows: await store.notifications.list('ann', { limit: 5 }) };
    },
  },
  {
    method: 'notifications.markReadByRef',
    name: 'own unread rows of the kind and ref only; a repeat changes nothing',
    run: async (store) => {
      const ask = (n: number, subject: string, kind: string, refId: string | null) =>
        store.notifications.insert({
          id: id(30 + n),
          subject,
          kind,
          category: null,
          connector: null,
          tool: 'search',
          entity: null,
          headline: `ask ${n}`,
          refUrl: '/chat/x',
          refId,
          agentId: null,
          agentName: null,
          runId: null,
          meta: null,
          createdAt: new Date(at(n)),
        });
      await ask(1, 'ann', 'chat_permission', 'toolu_1');
      await ask(2, 'ann', 'chat_permission', 'toolu_2');
      await ask(3, 'ann', 'other', 'toolu_1');
      await ask(4, 'bob', 'chat_permission', 'toolu_1');
      await ask(5, 'ann', 'chat_permission', null);
      const first = await store.notifications.markReadByRef('ann', 'chat_permission', 'toolu_1');
      const again = await store.notifications.markReadByRef('ann', 'chat_permission', 'toolu_1');
      const unread = async (subject: string) =>
        (await store.notifications.list(subject, { limit: 10, unreadOnly: true })).map(
          (n) => n.headline
        );
      return { first, again, ann: await unread('ann'), bob: await unread('bob') };
    },
  },
  {
    method: 'notifications.find',
    name: 'own row only; another person or an unknown id reads null',
    fixture,
    run: async (store) => [
      await store.notifications.find('ann', id(1)),
      await store.notifications.find('bob', id(1)),
      await store.notifications.find('ann', id(99)),
    ],
  },
  {
    method: 'notifications.savePushSubscription',
    name: 'insert, then a repeat endpoint re-points the row in place',
    fixture: pushFixture,
    run: async (store) => {
      await store.notifications.savePushSubscription('ann', {
        endpoint: 'https://push.test/new',
        p256dh: 'p-new',
        auth: 'a-new',
      });
      await store.notifications.savePushSubscription('ann', {
        endpoint: 'https://push.test/bob-1',
        p256dh: 'p-moved',
        auth: 'a-moved',
      });
      return {
        ann: (await store.notifications.listPushSubscriptions('ann')).map((s) => [
          s.endpoint,
          s.p256dh,
          s.auth,
        ]),
        bob: await store.notifications.listPushSubscriptions('bob'),
      };
    },
  },
  {
    method: 'notifications.deletePushSubscription',
    name: 'own endpoint only',
    fixture: pushFixture,
    run: async (store) => [
      await store.notifications.deletePushSubscription('ann', 'https://push.test/bob-1'),
      await store.notifications.deletePushSubscription('ann', 'https://push.test/ann-1'),
      await store.notifications.listPushSubscriptions('ann'),
      await store.notifications.listPushSubscriptions('bob'),
    ],
  },
  {
    method: 'notifications.deletePushSubscriptionByEndpoint',
    name: 'whoever holds it; an unknown endpoint deletes nothing',
    fixture: pushFixture,
    run: async (store) => [
      await store.notifications.deletePushSubscriptionByEndpoint('https://push.test/bob-1'),
      await store.notifications.deletePushSubscriptionByEndpoint('https://push.test/none'),
      await store.notifications.listPushSubscriptions('bob'),
    ],
  },
  {
    method: 'notifications.listPushSubscriptions',
    name: 'oldest first, ties by endpoint, per person',
    fixture: pushFixture,
    run: async (store) => [
      await store.notifications.listPushSubscriptions('ann'),
      await store.notifications.listPushSubscriptions('bob'),
      await store.notifications.listPushSubscriptions('nobody'),
    ],
  },
  {
    method: 'notifications.pingChatPresence',
    name: 'inserts, then moves the one row forward',
    fixture: presenceFixture,
    run: async (store) => {
      await store.notifications.pingChatPresence('ann', chat(2), new Date(at(5)));
      await store.notifications.pingChatPresence('ann', chat(1), new Date(at(9)));
      return [
        await store.notifications.wasWatchingChat('ann', chat(1), new Date(at(8))),
        await store.notifications.wasWatchingChat('ann', chat(2), new Date(at(4))),
        await store.notifications.wasWatchingChat('ann', chat(2), new Date(at(5))),
      ];
    },
  },
  {
    method: 'notifications.wasWatchingChat',
    name: 'strictly after the cutoff, own row only',
    fixture: presenceFixture,
    run: async (store) => [
      await store.notifications.wasWatchingChat('ann', chat(1), new Date(at(2))),
      await store.notifications.wasWatchingChat('ann', chat(1), new Date(at(3))),
      await store.notifications.wasWatchingChat('bob', chat(1), new Date(at(0))),
      await store.notifications.wasWatchingChat('ann', chat(3), new Date(at(0))),
    ],
  },
  {
    method: 'notifications.deleteChatPresenceBefore',
    name: 'strictly older rows go',
    fixture: presenceFixture,
    run: async (store) => [
      await store.notifications.deleteChatPresenceBefore(new Date(at(3))),
      await store.notifications.wasWatchingChat('ann', chat(1), new Date(at(0))),
      await store.notifications.wasWatchingChat('bob', chat(2), new Date(at(0))),
    ],
  },
];
