import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-12${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const now = new Date(at(30));

function delegation(
  n: number,
  subject: string,
  instance: number,
  scope: string,
  created: number,
  expires: number,
  session: string | null = null
) {
  return {
    id: id(n),
    subject,
    instance_id: id(instance),
    scope,
    session_id: session,
    sealed_key: `sealed-${n}`,
    created_at: at(created),
    expires_at: at(expires),
  };
}

const fixture = {
  user_encryption_keys: [
    {
      subject: 'ann',
      salt: 's',
      mode: 'held',
      version: 2,
      public_key: 'pub-ann',
      wrapped_private_key: 'wp',
      wrapped_automation_key: 'wa',
      enrolled_at: at(1),
      verifier: 'v',
    },
    { subject: 'old', salt: 's', mode: 'managed' },
    { subject: 'bob', salt: 's', mode: 'held', public_key: 'pub-bob' },
  ],
  sessions: [
    { id: id(91), subject: 'ann', expires_at: at(60) },
    { id: id(92), subject: 'ann', expires_at: at(60) },
    { id: id(93), subject: 'bob', expires_at: at(60) },
  ],
  delegate_instances: [
    { id: id(1), public_key: 'i1', started_at: at(2), heartbeat_at: at(29) },
    { id: id(2), public_key: 'i2', started_at: at(1), heartbeat_at: at(29) },
    { id: id(3), public_key: 'i3', started_at: at(1), heartbeat_at: at(29) },
    { id: id(4), public_key: 'i4', started_at: at(0), heartbeat_at: at(10) },
  ],
  key_delegations: [
    delegation(11, 'ann', 1, 'session', 5, 60, id(91)),
    delegation(12, 'ann', 1, 'automation', 6, 90),
    delegation(13, 'ann', 1, 'automation', 6, 90),
    delegation(14, 'ann', 1, 'session', 7, 20, id(92)),
    delegation(15, 'ann', 2, 'session', 4, 60, id(91)),
    delegation(16, 'ann', 4, 'automation', 3, 60),
    delegation(17, 'bob', 1, 'session', 8, 60, id(93)),
  ],
};

const sealedFixture = {
  ...fixture,
  resource_keys: [
    { id: id(31), resource_kind: 'chat', resource_id: id(41) },
    { id: id(32), resource_kind: 'chat', resource_id: id(42) },
  ],
  resource_key_grants: [
    {
      resource_key_id: id(32),
      holder_kind: 'user',
      holder: 'ann',
      wrapped_key: 'u-32',
      kek_version: 1,
    },
    {
      resource_key_id: id(31),
      holder_kind: 'user',
      holder: 'ann',
      wrapped_key: 'u-31',
      kek_version: 1,
    },
    {
      resource_key_id: id(31),
      holder_kind: 'automation',
      holder: 'ann',
      wrapped_key: 'a-31',
      kek_version: 1,
    },
    {
      resource_key_id: id(31),
      holder_kind: 'public',
      holder: 'ann',
      wrapped_key: 'p-31',
      kek_version: 1,
    },
    {
      resource_key_id: id(31),
      holder_kind: 'user',
      holder: 'bob',
      wrapped_key: 'u-31-bob',
      kek_version: 1,
    },
  ],
  provider_grants: [
    ['github', 'b-acct', 'ann'],
    ['github', 'a-acct', 'ann'],
    ['jira', 'z-acct', 'bob'],
  ].map(([provider, account, subject]) => ({
    provider,
    provider_account_id: account,
    subject,
    client_id: 'c',
    display_name: account,
    encrypted_access_token: `at-${account}`,
    encrypted_refresh_token: `rt-${account}`,
    expires_at: at(90),
    requested_scopes: [],
  })),
  chat_user_memories: [
    { id: id(81), owner_subject: 'ann', content: 'm-81' },
    { id: id(82), owner_subject: 'bob', content: 'm-82' },
  ],
};

/** New rows share a creation instant and random ids: compare them sorted. */
const sorted = <T extends { instanceId: string; scope: string }>(rows: T[]) =>
  [...rows].sort((a, b) =>
    `${a.scope}/${a.instanceId}`.localeCompare(`${b.scope}/${b.instanceId}`)
  );

const write = (sessionId: string, instances: number[], automation: number[]) => ({
  sessionId,
  session: instances.map((n) => ({ instanceId: id(n), sealedKey: `s-${n}` })),
  sessionExpiresAt: new Date(at(60)),
  automation: automation.map((n) => ({ instanceId: id(n), sealedKey: `a-${n}` })),
  automationExpiresAt: new Date(at(100)),
});

export const userKeyScenarios: Scenario<DataStore>[] = [
  {
    method: 'userKeys.registerInstance',
    name: 'a new instance is live at once',
    fixture,
    run: async (store) => [
      await store.userKeys.registerInstance(id(5), 'i5'),
      (await store.userKeys.liveInstances(new Date(at(28)))).map((i) => i.id),
    ],
  },
  {
    method: 'userKeys.heartbeatInstance',
    name: 'a stale instance beats and is live again; others untouched',
    fixture,
    run: async (store) => [
      await store.userKeys.heartbeatInstance(id(4), new Date(at(40))),
      await store.userKeys.liveInstances(new Date(at(30))),
      await store.userKeys.liveInstances(new Date(at(28))),
    ],
  },
  {
    method: 'userKeys.deleteStaleInstances',
    name: 'instances silent since before the cut go, with their delegations',
    fixture,
    run: async (store) => [
      await store.userKeys.deleteStaleInstances(new Date(at(20))),
      await store.userKeys.liveInstances(new Date(at(0))),
      await store.userKeys.delegationsOf('ann', now),
      await store.userKeys.deleteStaleInstances(new Date(at(20))),
    ],
  },
  {
    method: 'userKeys.deleteInstance',
    name: 'one instance and its delegations; a second delete is zero',
    fixture,
    run: async (store) => [
      await store.userKeys.deleteInstance(id(1)),
      await store.userKeys.deleteInstance(id(1)),
      await store.userKeys.liveDelegations('ann', id(1), now),
      await store.userKeys.liveDelegations('bob', id(1), now),
      await store.userKeys.delegationsOf('ann', now),
    ],
  },
  {
    method: 'userKeys.writeDelegations',
    name: "this session's rows replaced, unknown instances dropped, automation replaced only when given",
    fixture,
    run: async (store) => {
      await store.userKeys.writeDelegations('ann', write(id(91), [2, 77], [3, 77]));
      const first = sorted(await store.userKeys.delegationsOf('ann', now));
      await store.userKeys.writeDelegations('ann', write(id(92), [1], []));
      return [
        first,
        sorted(await store.userKeys.delegationsOf('ann', now)),
        await store.userKeys.liveDelegations('ann', id(3), now),
        await store.userKeys.delegationsOf('bob', now),
      ];
    },
  },
  {
    method: 'userKeys.revokeAutomation',
    name: "the person's automation rows only",
    fixture,
    run: async (store) => [
      await store.userKeys.revokeAutomation('ann'),
      await store.userKeys.revokeAutomation('ann'),
      await store.userKeys.delegationsOf('ann', now),
      await store.userKeys.delegationsOf('bob', now),
    ],
  },
  {
    method: 'userKeys.shred',
    name: 'key row, delegations and own wrappings go; others stay',
    fixture: sealedFixture,
    run: async (store) => [
      await store.userKeys.shred('ann'),
      await store.userKeys.findKeyRow('ann'),
      await store.userKeys.delegationsOf('ann', now),
      await store.resourceKeys.wrappings([id(31), id(32)]),
      await store.userKeys.delegationsOf('bob', now),
      await store.userKeys.shred('nobody'),
    ],
  },
  {
    method: 'userKeys.countByMode',
    name: 'one count per mode, by mode; empty when nobody has a row',
    fixture,
    run: async (store) => {
      const counts = await store.userKeys.countByMode();
      await store.userKeys.shred('ann');
      await store.userKeys.shred('bob');
      await store.userKeys.shred('old');
      return [counts, await store.userKeys.countByMode()];
    },
  },
  {
    method: 'userKeys.ensureLegacyRow',
    name: 'a managed row for a newcomer; an existing row is read as it is',
    fixture,
    run: async (store) => [
      await store.userKeys.ensureLegacyRow('newcomer', 'salt-1'),
      await store.userKeys.ensureLegacyRow('newcomer', 'salt-2'),
      await store.userKeys.ensureLegacyRow('ann', 'salt-3'),
      await store.userKeys.findKeyRow('newcomer'),
    ],
  },
  {
    method: 'userKeys.changeKeys',
    name: 'a plan that does not commit writes nothing; it sees the row and the sealed rows',
    fixture: sealedFixture,
    run: async (store) => {
      const seen = await store.userKeys.changeKeys('ann', async (current, readSealed) => ({
        commit: false,
        answer: { current, sealed: await readSealed() },
      }));
      const none = await store.userKeys.changeKeys('nobody', async (current, readSealed) => ({
        commit: false,
        answer: { current, sealed: await readSealed() },
      }));
      return [seen, none, await store.userKeys.findKeyRow('ann')];
    },
  },
  {
    method: 'userKeys.changeKeys',
    name: 'enrollment: legacy row turned held, rows re-sealed, delegations written',
    fixture: sealedFixture,
    run: async (store) => {
      const answer = await store.userKeys.changeKeys('old', async (current) => ({
        commit: true,
        answer: current?.version ?? -1,
        rewrite: { wrappings: [], values: [] },
        keyRow: {
          kind: 'enroll',
          salt: 'ignored-on-conflict',
          version: 2,
          publicKey: 'pub-old',
          wrappedPrivateKey: 'wp-old',
          wrappedAutomationKey: 'wa-old',
          enrolledAt: new Date(at(30)),
          verifier: 'v-old',
          rotatedAt: new Date(at(30)),
        },
        dropDelegations: false,
        delegations: write(id(93), [1], [2]),
      }));
      const fresh = await store.userKeys.changeKeys('fresh', async () => ({
        commit: true,
        answer: 'fresh',
        rewrite: { wrappings: [], values: [] },
        keyRow: {
          kind: 'enroll',
          salt: 'salt-fresh',
          version: 1,
          publicKey: 'pub-fresh',
          wrappedPrivateKey: 'wp',
          wrappedAutomationKey: 'wa',
          enrolledAt: new Date(at(31)),
          verifier: 'v',
          rotatedAt: null,
        },
        dropDelegations: false,
        delegations: write(id(93), [], []),
      }));
      const ann = await store.userKeys.changeKeys('ann', async (_current, readSealed) => {
        const sealed = await readSealed();
        return {
          commit: true,
          answer: sealed.values.length,
          rewrite: {
            wrappings: sealed.wrappings.map((w) => ({
              resourceKeyId: w.resourceKeyId,
              holderKind: w.holderKind,
              wrappedKey: `${w.wrappedKey}-next`,
              kekVersion: 3,
            })),
            values: sealed.values.map((v) => ({
              table: v.table,
              id: v.id,
              values: Object.fromEntries(
                Object.entries(v.values).map(([column, stored]) => [column, `${stored}-next`])
              ),
            })),
          },
          keyRow: {
            kind: 'rotate',
            version: 3,
            wrappedPrivateKey: 'wp-3',
            wrappedAutomationKey: 'wa-3',
            rotatedAt: new Date(at(32)),
          },
          dropDelegations: true,
          delegations: write(id(91), [2], []),
        };
      });
      return [
        answer,
        fresh,
        ann,
        await store.userKeys.findKeyRow('old'),
        await store.userKeys.findKeyRow('fresh'),
        await store.userKeys.findKeyRow('ann'),
        sorted(await store.userKeys.delegationsOf('old', now)),
        sorted(await store.userKeys.delegationsOf('ann', now)),
        await store.resourceKeys.wrappings([id(31), id(32)]),
        await store.userKeys.changeKeys('ann', async (_c, readSealed) => ({
          commit: false,
          answer: await readSealed(),
        })),
        await store.userKeys.changeKeys('bob', async (_c, readSealed) => ({
          commit: false,
          answer: await readSealed(),
        })),
      ];
    },
  },
  {
    method: 'userKeys.findKeyRow',
    name: 'held and legacy rows as stored; nobody reads null',
    fixture,
    run: async (store) => [
      await store.userKeys.findKeyRow('ann'),
      await store.userKeys.findKeyRow('old'),
      await store.userKeys.findKeyRow('nobody'),
    ],
  },
  {
    method: 'userKeys.liveDelegations',
    name: 'this instance, unexpired, newest first, ties by id descending',
    fixture,
    run: async (store) => [
      await store.userKeys.liveDelegations('ann', id(1), now),
      await store.userKeys.liveDelegations('ann', id(2), now),
      await store.userKeys.liveDelegations('ann', id(3), now),
      await store.userKeys.liveDelegations('bob', id(2), now),
    ],
  },
  {
    method: 'userKeys.delegationsOf',
    name: 'every unexpired delegation of the person, oldest first',
    fixture,
    run: async (store) => [
      await store.userKeys.delegationsOf('ann', now),
      await store.userKeys.delegationsOf('ann', new Date(at(70))),
      await store.userKeys.delegationsOf('nobody', now),
    ],
  },
  {
    method: 'userKeys.liveInstances',
    name: 'recent heartbeat only, by start time then id',
    fixture,
    run: async (store) => [
      await store.userKeys.liveInstances(new Date(at(28))),
      await store.userKeys.liveInstances(new Date(at(29))),
      await store.userKeys.liveInstances(new Date(at(0))),
    ],
  },
];
