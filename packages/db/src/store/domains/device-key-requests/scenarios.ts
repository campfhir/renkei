import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function ask(
  n: number,
  subject: string,
  minute: number,
  state: { sealed?: boolean; consumed?: boolean; denied?: boolean; expiresAt?: number } = {}
) {
  return {
    id: id(n),
    subject,
    public_key: `pk-${n}`,
    code: `CODE${n}`,
    sealed_key: state.sealed ? 'sbox1:x' : null,
    asking_session_id: null,
    user_agent: n % 2 ? 'Firefox' : null,
    attempts: n === 1 ? 2 : 0,
    consumed_at: state.consumed ? at(minute + 1) : null,
    denied_at: state.denied ? at(minute + 1) : null,
    created_at: at(minute),
    expires_at: at(state.expiresAt ?? minute + 10),
  };
}

const fixture = {
  device_key_requests: [
    ask(1, 'ann', 5),
    ask(2, 'ann', 3),
    ask(3, 'ann', 3),
    ask(4, 'ann', 1, { sealed: true }),
    ask(5, 'ann', 2, { consumed: true }),
    ask(6, 'ann', 2, { denied: true }),
    ask(7, 'ann', 0, { expiresAt: 4 }),
    ask(8, 'bob', 3),
  ],
};

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

export const deviceKeyRequestScenarios: Scenario<DataStore>[] = [
  {
    method: 'deviceKeyRequests.listPending',
    name: 'open asks only, oldest first, ties by id',
    fixture,
    run: async (store) => [
      await store.deviceKeyRequests.listPending('ann', at(4)),
      ids(await store.deviceKeyRequests.listPending('ann', at(3))),
      ids(await store.deviceKeyRequests.listPending('ann', at(15))),
      ids(await store.deviceKeyRequests.listPending('cy', at(0))),
    ],
  },
  {
    method: 'deviceKeyRequests.purgeBefore',
    name: 'own rows strictly before',
    fixture,
    run: async (store) => [
      await store.deviceKeyRequests.purgeBefore('ann', at(3)),
      ids(await store.deviceKeyRequests.listPending('ann', at(0))),
      await store.deviceKeyRequests.countSince('bob', at(0)),
    ],
  },
  {
    method: 'deviceKeyRequests.countSince',
    name: 'inclusive bound, whatever the state',
    fixture,
    run: async (store) => [
      await store.deviceKeyRequests.countSince('ann', at(2)),
      await store.deviceKeyRequests.countSince('ann', at(6)),
      await store.deviceKeyRequests.countSince('bob', at(3)),
    ],
  },
  {
    method: 'deviceKeyRequests.create',
    name: 'defaults filled in, readable after',
    fixture: { sessions: [{ id: id(50), subject: 'ann', expires_at: at(500) }] },
    run: async (store) => {
      const created = await store.deviceKeyRequests.create({
        subject: 'ann',
        publicKey: 'pk',
        code: 'ABCDE12345',
        askingSessionId: id(50),
        userAgent: null,
        expiresAt: at(20),
      });
      const read = await store.deviceKeyRequests.get('ann', created.id);
      const { id: _id, createdAt: _createdAt, ...rest } = created;
      return {
        rest,
        same: read?.code === created.code,
        count: await store.deviceKeyRequests.countSince('ann', at(0)),
      };
    },
  },
  {
    method: 'deviceKeyRequests.get',
    name: 'own only; malformed id refused',
    fixture,
    run: async (store) => [
      await store.deviceKeyRequests.get('ann', id(1)),
      await store.deviceKeyRequests.get('ann', id(8)),
      await store.deviceKeyRequests.get('ann', 'zz').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      ),
    ],
  },
  {
    method: 'deviceKeyRequests.recordMiss',
    name: 'counts, and denies on the last miss',
    fixture,
    run: async (store) => {
      await store.deviceKeyRequests.recordMiss(id(1), 3, null);
      await store.deviceKeyRequests.recordMiss(id(2), 5, at(9));
      return [
        await store.deviceKeyRequests.get('ann', id(1)),
        await store.deviceKeyRequests.get('ann', id(2)),
      ];
    },
  },
  {
    method: 'deviceKeyRequests.consume',
    name: 'clears the sealed key',
    fixture,
    run: async (store) => {
      await store.deviceKeyRequests.consume(id(4), at(9));
      return store.deviceKeyRequests.get('ann', id(4));
    },
  },
  {
    method: 'deviceKeyRequests.seal',
    name: 'only an open, unexpired ask',
    fixture: {
      ...fixture,
      sessions: [{ id: id(50), subject: 'ann', expires_at: at(500) }],
    },
    run: async (store) => [
      await store.deviceKeyRequests.seal(id(1), 'sbox1:y', id(50), at(6)),
      await store.deviceKeyRequests.seal(id(1), 'sbox1:z', id(50), at(6)),
      await store.deviceKeyRequests.seal(id(6), 'sbox1:z', id(50), at(6)),
      await store.deviceKeyRequests.seal(id(7), 'sbox1:z', id(50), at(6)),
      (await store.deviceKeyRequests.get('ann', id(1)))?.sealedKey,
    ],
  },
  {
    method: 'deviceKeyRequests.deny',
    name: 'own, not yet denied',
    fixture,
    run: async (store) => [
      await store.deviceKeyRequests.deny('ann', id(4), at(9)),
      await store.deviceKeyRequests.deny('ann', id(6), at(9)),
      await store.deviceKeyRequests.deny('ann', id(8), at(9)),
      await store.deviceKeyRequests.get('ann', id(4)),
    ],
  },
];
