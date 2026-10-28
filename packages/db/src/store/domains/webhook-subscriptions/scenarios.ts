import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function subscription(n: number, account: string, resource: string, subscriptionId: string | null) {
  return {
    id: id(n),
    provider: n === 6 ? 'zoom' : 'microsoft',
    account_id: account,
    resource,
    subscription_id: subscriptionId,
    client_state: `state-${n}`,
    subject: 'ann',
  };
}

const fixture = {
  webhook_subscriptions: [
    subscription(3, 'acct-a', 'me/messages', 'sub-3'),
    subscription(1, 'acct-a', 'me/events', 'sub-1'),
    subscription(2, 'acct-a', 'me/contacts', null),
    subscription(4, 'acct-b', 'me/messages', 'sub-4'),
    subscription(6, 'acct-a', 'me/messages', 'sub-6'),
  ],
};

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const syncFixture = {
  webhook_subscriptions: [
    {
      ...subscription(3, 'acct-a', 'me/messages', 'sub-3'),
      expires_at: at(30),
      delta_link: 'delta-3',
      total_items: 5,
      last_run_items: 2,
      last_synced_at: at(10),
    },
    { ...subscription(1, 'acct-a', 'me/events', 'sub-1'), sync_status: 'syncing' },
    subscription(2, 'acct-a', 'me/contacts', null),
    { ...subscription(4, 'acct-b', 'me/messages', 'sub-4'), delta_link: 'delta-4' },
    subscription(6, 'acct-a', 'me/messages', 'sub-6'),
  ],
};

type SyncStates = Awaited<ReturnType<DataStore['webhookSubscriptions']['listSyncStates']>>;

/** lastSyncedAt is now() after a round: compare whether it is set, not when. */
const syncView = (rows: SyncStates) =>
  rows.map((row) => ({ ...row, lastSyncedAt: row.lastSyncedAt !== null }));

export const webhookSubscriptionScenarios: Scenario<DataStore>[] = [
  {
    method: 'webhookSubscriptions.listForAccount',
    name: 'one account on one provider, by resource then id',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.listForAccount('microsoft', 'acct-a'),
      await store.webhookSubscriptions.listForAccount('microsoft', 'acct-b'),
      await store.webhookSubscriptions.listForAccount('zoom', 'acct-a'),
      await store.webhookSubscriptions.listForAccount('microsoft', 'nobody'),
    ],
  },
  {
    method: 'webhookSubscriptions.deleteForAccount',
    name: 'that account on that provider only',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.deleteForAccount('microsoft', 'acct-a'),
      await store.webhookSubscriptions.deleteForAccount('microsoft', 'acct-a'),
      await store.webhookSubscriptions.listForAccount('microsoft', 'acct-a'),
      (await store.webhookSubscriptions.listForAccount('microsoft', 'acct-b')).map((s) => s.id),
      (await store.webhookSubscriptions.listForAccount('zoom', 'acct-a')).map((s) => s.id),
    ],
  },
  {
    method: 'webhookSubscriptions.insertIfMissing',
    name: 'a new resource lands; an existing (provider, account, resource) is left alone',
    fixture: syncFixture,
    run: async (store) => {
      const fresh = await store.webhookSubscriptions.insertIfMissing({
        id: id(10),
        provider: 'microsoft',
        accountId: 'acct-a',
        resource: 'me/todo',
        clientState: 'state-10',
      });
      const again = await store.webhookSubscriptions.insertIfMissing({
        id: id(11),
        provider: 'microsoft',
        accountId: 'acct-a',
        resource: 'me/messages',
        clientState: 'state-11',
      });
      const otherProvider = await store.webhookSubscriptions.insertIfMissing({
        id: id(12),
        provider: 'zoom',
        accountId: 'acct-b',
        resource: 'me/messages',
        clientState: 'state-12',
      });
      return {
        fresh,
        again,
        otherProvider,
        a: syncView(await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-a')),
        zoom: syncView(await store.webhookSubscriptions.listSyncStates('zoom', 'acct-b')),
      };
    },
  },
  {
    method: 'webhookSubscriptions.listSyncStates',
    name: 'one account on one provider, by resource then id; empty for strangers',
    fixture: syncFixture,
    run: async (store) => [
      await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-a'),
      await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-b'),
      await store.webhookSubscriptions.listSyncStates('zoom', 'acct-a'),
      await store.webhookSubscriptions.listSyncStates('microsoft', 'nobody'),
    ],
  },
  {
    method: 'webhookSubscriptions.findSyncStateBySubscriptionId',
    name: "the account's row only; another account's or provider's id misses",
    fixture: syncFixture,
    run: async (store) => [
      await store.webhookSubscriptions.findSyncStateBySubscriptionId(
        'microsoft',
        'acct-a',
        'sub-3'
      ),
      await store.webhookSubscriptions.findSyncStateBySubscriptionId(
        'microsoft',
        'acct-a',
        'sub-4'
      ),
      await store.webhookSubscriptions.findSyncStateBySubscriptionId(
        'microsoft',
        'acct-a',
        'sub-6'
      ),
      await store.webhookSubscriptions.findSyncStateBySubscriptionId('zoom', 'acct-a', 'sub-6'),
      await store.webhookSubscriptions.findSyncStateBySubscriptionId('microsoft', 'acct-a', 'gone'),
    ],
  },
  {
    method: 'webhookSubscriptions.setProviderSubscription',
    name: 'id and expiry set, expiry alone, both cleared; other rows untouched',
    fixture: syncFixture,
    run: async (store) => {
      await store.webhookSubscriptions.setProviderSubscription(id(2), {
        subscriptionId: 'sub-2',
        expiresAt: at(50),
      });
      await store.webhookSubscriptions.setProviderSubscription(id(3), { expiresAt: at(45) });
      await store.webhookSubscriptions.setProviderSubscription(id(1), {
        subscriptionId: null,
        expiresAt: null,
      });
      await store.webhookSubscriptions.setProviderSubscription(id(99), { expiresAt: at(1) });
      return [
        await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-a'),
        await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-b'),
      ];
    },
  },
  {
    method: 'webhookSubscriptions.setProviderSubscriptionBySubscriptionId',
    name: "on that provider's row; another provider's same id stays",
    fixture: {
      webhook_subscriptions: [
        { ...subscription(3, 'acct-a', 'me/messages', 'shared'), expires_at: at(30) },
        { ...subscription(6, 'acct-a', 'me/messages', 'shared'), expires_at: at(30) },
        subscription(4, 'acct-b', 'me/messages', 'sub-4'),
      ],
    },
    run: async (store) => {
      const renewed = await store.webhookSubscriptions.setProviderSubscriptionBySubscriptionId(
        'microsoft',
        'shared',
        { expiresAt: at(55) }
      );
      const cleared = await store.webhookSubscriptions.setProviderSubscriptionBySubscriptionId(
        'microsoft',
        'sub-4',
        { subscriptionId: null, expiresAt: null }
      );
      const missing = await store.webhookSubscriptions.setProviderSubscriptionBySubscriptionId(
        'microsoft',
        'nope',
        { subscriptionId: null }
      );
      return {
        renewed,
        cleared,
        missing,
        a: await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-a'),
        b: await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-b'),
        zoom: await store.webhookSubscriptions.listSyncStates('zoom', 'acct-a'),
      };
    },
  },
  {
    method: 'webhookSubscriptions.restartDelta',
    name: 'cursor dropped and syncing, that row only',
    fixture: syncFixture,
    run: async (store) => {
      await store.webhookSubscriptions.restartDelta(id(3));
      return [
        await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-a'),
        await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-b'),
      ];
    },
  },
  {
    method: 'webhookSubscriptions.recordDeltaRound',
    name: 'cursor, counts added to the total, status; synced now; other rows stay',
    fixture: syncFixture,
    run: async (store) => {
      await store.webhookSubscriptions.recordDeltaRound(id(3), {
        cursor: 'next-3',
        changed: 4,
        syncStatus: 'syncing',
      });
      await store.webhookSubscriptions.recordDeltaRound(id(2), {
        cursor: null,
        changed: 0,
        syncStatus: 'idle',
      });
      return [
        syncView(await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-a')),
        syncView(await store.webhookSubscriptions.listSyncStates('microsoft', 'acct-b')),
      ];
    },
  },
  {
    method: 'webhookSubscriptions.listForProvider',
    name: 'every account on one provider, by account, resource, id; none',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.listForProvider('microsoft'),
      await store.webhookSubscriptions.listForProvider('nobody'),
    ],
  },
  {
    method: 'webhookSubscriptions.delete',
    name: 'one row by id; unknown ids delete nothing',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.delete(id(1)),
      await store.webhookSubscriptions.delete(id(1)),
      await store.webhookSubscriptions.delete(id(99)),
      (await store.webhookSubscriptions.listForAccount('microsoft', 'acct-a')).map((s) => s.id),
    ],
  },
  {
    method: 'webhookSubscriptions.listStale',
    name: 'one account, untouched since the cutoff, by resource then id',
    fixture: {
      webhook_subscriptions: [
        {
          ...subscription(3, 'acct-a', 'me/messages', 'sub-3'),
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
        {
          ...subscription(1, 'acct-a', 'me/events', 'sub-1'),
          updated_at: new Date('2026-01-01T00:00:00Z'),
          expires_at: new Date('2026-01-03T00:00:00Z'),
          delta_link: 'https://graph.test/delta?token=1',
        },
        {
          ...subscription(2, 'acct-a', 'me/contacts', null),
          updated_at: new Date('2026-02-01T00:00:00Z'),
        },
        {
          ...subscription(4, 'acct-b', 'me/messages', 'sub-4'),
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    },
    run: async (store) => [
      await store.webhookSubscriptions.listStale(
        'microsoft',
        'acct-a',
        new Date('2026-01-15T00:00:00Z')
      ),
      await store.webhookSubscriptions.listStale('microsoft', 'acct-a', new Date('2025-01-01')),
    ],
  },
];
