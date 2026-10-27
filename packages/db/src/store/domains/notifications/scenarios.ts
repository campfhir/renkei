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
];
