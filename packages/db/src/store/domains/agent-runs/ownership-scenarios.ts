import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-17${String(n).padStart(10, '0')}`;
const refusal = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : 'threw';

const fixture = {
  agents: [{ id: id(1), owner_subject: 'ann', name: 'A' }],
  agent_runs: [
    { id: id(11), agent_id: id(1), owner_subject: 'ann', trigger_kind: 'manual' },
    { id: id(12), agent_id: id(1), owner_subject: 'bob', trigger_kind: 'manual' },
  ],
};

export const agentRunOwnershipScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentRuns.isOwnedBy',
    name: "the owner's run only; unknown false, malformed refused",
    fixture,
    run: async (store) => [
      await store.agentRuns.isOwnedBy(id(11), 'ann'),
      await store.agentRuns.isOwnedBy(id(11), 'bob'),
      await store.agentRuns.isOwnedBy(id(12), 'bob'),
      await store.agentRuns.isOwnedBy(id(99), 'ann'),
      await store.agentRuns.isOwnedBy(id(11).toUpperCase(), 'ann'),
      await store.agentRuns.isOwnedBy('------------------------------------', 'ann').catch(refusal),
    ],
  },
];
