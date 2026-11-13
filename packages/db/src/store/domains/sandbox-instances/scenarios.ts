import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const fixture = {
  sandbox_instances: [
    { id: 'sandbox-a', address: 'http://10.0.0.1:8092', started_at: at(0), last_seen_at: at(30) },
    { id: 'sandbox-b', address: 'http://10.0.0.2:8092', started_at: at(1), last_seen_at: at(30) },
    { id: 'sandbox-c', address: 'http://10.0.0.3:8092', started_at: at(2), last_seen_at: at(10) },
  ],
  sandbox_assignments: [
    { subject: 'ann', instance_id: 'sandbox-a', assigned_at: at(5) },
    { subject: 'bob', instance_id: 'sandbox-a', assigned_at: at(6) },
    { subject: 'code-project:p1', instance_id: 'sandbox-b', assigned_at: at(7) },
    { subject: 'cy', instance_id: 'sandbox-gone', assigned_at: at(8) },
  ],
};

export const sandboxInstanceScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxInstances.heartbeat',
    name: 'a new instance gets a row; one already there has its address, start and last-seen moved',
    fixture,
    run: async (store) => {
      await store.sandboxInstances.heartbeat({
        id: 'sandbox-d',
        address: 'http://10.0.0.4:8092',
        startedAt: at(40),
        at: at(41),
      });
      await store.sandboxInstances.heartbeat({
        id: 'sandbox-c',
        address: 'http://10.0.0.9:8092',
        startedAt: at(42),
        at: at(43),
      });
      return [await store.sandboxInstances.listLive(at(0))];
    },
  },
  {
    method: 'sandboxInstances.removeUnseenSince',
    name: 'strictly before the cut only; a caller of one that went stays assigned to it, with no instance behind',
    fixture: {
      ...fixture,
      sandbox_assignments: [
        ...fixture.sandbox_assignments,
        { subject: 'dan', instance_id: 'sandbox-c', assigned_at: at(9) },
      ],
    },
    run: async (store) => [
      await store.sandboxInstances.removeUnseenSince(at(10)),
      await store.sandboxInstances.removeUnseenSince(at(11)),
      await store.sandboxInstances.listLive(at(0)),
      await store.sandboxInstances.assignment('dan'),
    ],
  },
  {
    method: 'sandboxInstances.listLive',
    name: 'those seen since the cut (inclusive), fewest callers first, then by id',
    fixture,
    run: async (store) => [
      await store.sandboxInstances.listLive(at(0)),
      await store.sandboxInstances.listLive(at(10)),
      await store.sandboxInstances.listLive(at(11)),
      await store.sandboxInstances.listLive(at(31)),
    ],
  },
  {
    method: 'sandboxInstances.assignment',
    name: 'a caller’s instance with its row; one whose instance is gone; one never assigned',
    fixture,
    run: async (store) => [
      await store.sandboxInstances.assignment('ann'),
      await store.sandboxInstances.assignment('code-project:p1'),
      await store.sandboxInstances.assignment('cy'),
      await store.sandboxInstances.assignment('nobody'),
    ],
  },
  {
    method: 'sandboxInstances.assign',
    name: 'first come: a new caller is assigned, a taken one keeps its instance, a move needs the instance it is moving from',
    fixture,
    run: async (store) => [
      // Nobody yet: assigned as asked.
      await store.sandboxInstances.assign({
        subject: 'dee',
        instanceId: 'sandbox-b',
        replacing: null,
        at: at(50),
      }),
      // Already ann's: the first choice stands.
      await store.sandboxInstances.assign({
        subject: 'ann',
        instanceId: 'sandbox-b',
        replacing: null,
        at: at(51),
      }),
      // Moved off the instance that is gone.
      await store.sandboxInstances.assign({
        subject: 'cy',
        instanceId: 'sandbox-b',
        replacing: 'sandbox-gone',
        at: at(52),
      }),
      // A move from where the caller no longer is: someone moved it first.
      await store.sandboxInstances.assign({
        subject: 'cy',
        instanceId: 'sandbox-a',
        replacing: 'sandbox-gone',
        at: at(53),
      }),
      // A move for a caller with no assignment at all moves nothing.
      await store.sandboxInstances.assign({
        subject: 'eve',
        instanceId: 'sandbox-a',
        replacing: 'sandbox-b',
        at: at(54),
      }),
      await store.sandboxInstances.assignment('dee'),
      await store.sandboxInstances.assignment('ann'),
      await store.sandboxInstances.assignment('cy'),
      await store.sandboxInstances.assignment('eve'),
      await store.sandboxInstances.listLive(at(11)),
    ],
  },
];
