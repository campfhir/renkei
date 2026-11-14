import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const ID = {
  ann: '00000000-0000-4000-8000-000000000001',
  agent: '00000000-0000-4000-8000-000000000002',
  project: '00000000-0000-4000-8000-000000000003',
  gone: '00000000-0000-4000-8000-000000000004',
  starting: '00000000-0000-4000-8000-000000000005',
  fresh: '00000000-0000-4000-8000-000000000006',
};

function row(
  id: string,
  routeKey: string,
  kind: string,
  state: string,
  minutes: { created: number; active: number; changed: number },
  extra: {
    provider_id?: string | null;
    address?: string | null;
    error?: string | null;
    subjects?: string[];
  } = {}
) {
  return {
    id,
    route_key: routeKey,
    kind,
    provider: 'docker',
    provider_id: extra.provider_id ?? null,
    state,
    address: extra.address ?? null,
    error: extra.error ?? null,
    created_at: at(minutes.created),
    last_active_at: at(minutes.active),
    state_changed_at: at(minutes.changed),
    verified_at: at(minutes.changed),
    subjects: extra.subjects ?? [],
  };
}

const fixture = {
  sandboxes: [
    row(
      ID.ann,
      'ann',
      'user',
      'running',
      { created: 0, active: 30, changed: 1 },
      {
        provider_id: 'c-ann',
        address: 'http://10.0.0.1:8092',
      }
    ),
    row(
      ID.agent,
      'agent:a1',
      'agent',
      'suspended',
      { created: 2, active: 10, changed: 25 },
      {
        provider_id: 'c-agent',
      }
    ),
    row(
      ID.project,
      'code-project:p1',
      'project',
      'running',
      { created: 3, active: 20, changed: 4 },
      {
        provider_id: 'c-project',
        address: 'http://10.0.0.3:8092',
        subjects: ['code-project:p1', 'ann'],
      }
    ),
    row(
      ID.gone,
      'ann',
      'user',
      'deleted',
      { created: 0, active: 0, changed: 5 },
      {
        error: 'the engine did not answer',
      }
    ),
    row(ID.starting, 'bob', 'user', 'provisioning', { created: 28, active: 28, changed: 28 }),
  ],
};

export const sandboxScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxes.claim',
    name: 'a scope with no sandbox, or only a deleted one, gets a provisioning row; one that has a live sandbox gets null',
    fixture,
    run: async (store) => [
      await store.sandboxes.claim({
        id: ID.fresh,
        routeKey: 'cy',
        kind: 'user',
        provider: 'azure',
        at: at(40),
      }),
      await store.sandboxes.claim({
        id: '00000000-0000-4000-8000-000000000007',
        routeKey: 'ann',
        kind: 'user',
        provider: 'docker',
        at: at(41),
      }),
      await store.sandboxes.claim({
        id: '00000000-0000-4000-8000-000000000008',
        routeKey: 'bob',
        kind: 'user',
        provider: 'docker',
        at: at(42),
      }),
      await store.sandboxes.live('cy'),
      await store.sandboxes.live('ann'),
    ],
  },
  {
    method: 'sandboxes.live',
    name: 'the one that is not deleted; nothing for a scope never seen',
    fixture,
    run: async (store) => [
      await store.sandboxes.live('ann'),
      await store.sandboxes.live('agent:a1'),
      await store.sandboxes.live('nobody'),
    ],
  },
  {
    method: 'sandboxes.get',
    name: 'by id, deleted ones included',
    fixture,
    run: async (store) => [
      await store.sandboxes.get(ID.project),
      await store.sandboxes.get(ID.gone),
      await store.sandboxes.get('00000000-0000-4000-8000-0000000000ff'),
    ],
  },
  {
    method: 'sandboxes.transition',
    name: 'moves only from a named state, once; given fields change, null clears, the rest stay',
    fixture,
    run: async (store) => [
      await store.sandboxes.transition({
        id: ID.ann,
        from: ['running'],
        to: 'suspending',
        at: at(50),
      }),
      await store.sandboxes.transition({
        id: ID.ann,
        from: ['running'],
        to: 'suspending',
        at: at(51),
      }),
      await store.sandboxes.transition({
        id: ID.ann,
        from: ['suspending', 'running'],
        to: 'suspended',
        at: at(52),
        address: null,
      }),
      await store.sandboxes.transition({
        id: ID.starting,
        from: ['provisioning'],
        to: 'running',
        at: at(53),
        providerId: 'c-bob',
        address: 'http://10.0.0.5:8092',
      }),
      await store.sandboxes.transition({
        id: ID.agent,
        from: ['suspended'],
        to: 'deleted',
        at: at(54),
        error: 'idle for a day',
      }),
      await store.sandboxes.get(ID.ann),
      await store.sandboxes.get(ID.starting),
      await store.sandboxes.get(ID.agent),
    ],
  },
  {
    method: 'sandboxes.touch',
    name: 'last activity moves forward, never back',
    fixture,
    run: async (store) => {
      await store.sandboxes.touch(ID.ann, at(45));
      await store.sandboxes.touch(ID.project, at(15));
      return [await store.sandboxes.get(ID.ann), await store.sandboxes.get(ID.project)];
    },
  },
  {
    method: 'sandboxes.verified',
    name: 'only the verified time moves',
    fixture,
    run: async (store) => {
      await store.sandboxes.verified(ID.ann, at(46));
      return [await store.sandboxes.get(ID.ann)];
    },
  },
  {
    method: 'sandboxes.list',
    name: 'by state, strictly before either cut, least recently active first then by id, capped',
    fixture,
    run: async (store) => [
      await store.sandboxes.list({ states: ['running', 'suspended'], limit: 10 }),
      await store.sandboxes.list({
        states: ['running', 'suspended'],
        lastActiveBefore: at(20),
        limit: 10,
      }),
      await store.sandboxes.list({
        states: ['running', 'suspended'],
        lastActiveBefore: at(21),
        limit: 10,
      }),
      await store.sandboxes.list({
        states: ['provisioning', 'suspended'],
        stateChangedBefore: at(28),
        limit: 10,
      }),
      await store.sandboxes.list({ states: ['running', 'suspended', 'provisioning'], limit: 2 }),
      await store.sandboxes.list({ states: [], limit: 10 }),
    ],
  },
  {
    method: 'sandboxes.purgeDeleted',
    name: 'deleted rows strictly before the cut go; live ones never',
    fixture,
    run: async (store) => [
      await store.sandboxes.purgeDeleted(at(5)),
      await store.sandboxes.purgeDeleted(at(60)),
      await store.sandboxes.get(ID.gone),
      await store.sandboxes.list({
        states: ['provisioning', 'running', 'suspended'],
        limit: 10,
      }),
    ],
  },
  {
    method: 'sandboxes.allowSubject',
    name: 'a subject is added once, in the order it came, up to the limit; a sandbox that is not there serves nobody',
    fixture,
    run: async (store) => [
      await store.sandboxes.allowSubject(ID.ann, 'ann', 3),
      await store.sandboxes.allowSubject(ID.ann, 'ann', 3),
      await store.sandboxes.allowSubject(ID.project, 'bob', 3),
      await store.sandboxes.allowSubject(ID.project, 'ann', 3),
      // Full: a fourth is not added, and the call says so.
      await store.sandboxes.allowSubject(ID.project, 'cy', 3),
      await store.sandboxes.allowSubject('00000000-0000-4000-8000-0000000000ff', 'ann', 3),
      await store.sandboxes.get(ID.ann),
      await store.sandboxes.get(ID.project),
    ],
  },
];
