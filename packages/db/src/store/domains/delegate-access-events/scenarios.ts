import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-15${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function event(n: number, minute: number, op: string) {
  return {
    id: id(n),
    created_at: at(minute),
    caller: 'web',
    op,
    subject_hash: n % 2 ? `h${n}` : null,
    target: n % 3 ? null : `t${n}`,
    outcome: 'ok',
    status: 200,
  };
}

const fixture = {
  delegate_access_events: [
    event(1, 1, 'keys/shred'),
    event(2, 3, 'keys/rotate'),
    event(3, 3, 'resource-key/share'),
    event(4, 2, 'grant/git-ticket'),
  ],
};

export const delegateAccessEventScenarios: Scenario<DataStore>[] = [
  {
    method: 'delegateAccessEvents.recent',
    name: 'newest first, ties by id descending, limited; empty when none',
    fixture,
    run: async (store) => [
      await store.delegateAccessEvents.recent(3),
      await store.delegateAccessEvents.recent(10),
    ],
  },
  {
    method: 'delegateAccessEvents.recent',
    name: 'nothing recorded reads empty',
    run: async (store) => store.delegateAccessEvents.recent(5),
  },
  {
    method: 'delegateAccessEvents.record',
    name: 'an appended row reads back newest (generated id and time left out)',
    fixture,
    run: async (store) => {
      await store.delegateAccessEvents.record({
        caller: 'agents',
        op: 'keys/shred',
        subjectHash: null,
        target: 'x',
        outcome: 'refused',
        status: 403,
      });
      const [newest, ...rest] = await store.delegateAccessEvents.recent(10);
      const { id: _id, createdAt: _at, ...fields } = newest;
      return [fields, rest.length];
    },
  },
];
