import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { AgentOptimizationRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-e${String(n).padStart(11, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const agents = [
  { id: id(1), owner_subject: 'ann', name: 'A' },
  { id: id(2), owner_subject: 'bob', name: 'B' },
];

function pass(
  n: number,
  agent: number,
  owner: string,
  minute: number,
  extra: Record<string, unknown> = {}
) {
  return {
    id: id(n),
    agent_id: id(agent),
    owner_subject: owner,
    request: JSON.stringify({ windowDays: 30 }),
    created_at: at(minute),
    ...extra,
  };
}

const fixture = {
  agents,
  agent_optimizations: [
    pass(11, 1, 'ann', 1, {
      status: 'succeeded',
      result: JSON.stringify({ summary: 's' }),
      finished_at: at(2),
    }),
    pass(12, 1, 'ann', 3, { status: 'failed', error: 'no model' }),
    pass(13, 1, 'ann', 3, { status: 'running' }),
    pass(14, 2, 'bob', 4),
    pass(15, 1, 'ann', 0, { status: 'queued' }),
  ],
};

/** Leaves out what a write stamps with now(). */
function settled(row: AgentOptimizationRecord | null) {
  return (
    row && {
      ...row,
      finishedAt: row.finishedAt ? 'set' : null,
      appliedAt: row.appliedAt ? 'set' : null,
    }
  );
}

export const agentOptimizationScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentOptimizations.create',
    name: 'queued with its request, readable by the owner',
    fixture: { agents },
    run: async (store) => {
      const created = await store.agentOptimizations.create({
        ownerSubject: 'ann',
        agentId: id(1),
        request: { windowDays: 14 },
      });
      const row = await store.agentOptimizations.find('ann', created);
      return row && { ...row, id: undefined, createdAt: undefined };
    },
  },
  {
    method: 'agentOptimizations.find',
    name: "the owner's pass only",
    fixture,
    run: async (store) => [
      await store.agentOptimizations.find('ann', id(11)),
      await store.agentOptimizations.find('bob', id(11)),
      await store.agentOptimizations.find('ann', id(99)),
    ],
  },
  {
    method: 'agentOptimizations.latest',
    name: 'newest whatever the status, ties by id',
    fixture,
    run: async (store) => [
      (await store.agentOptimizations.latest('ann', id(1)))?.id,
      await store.agentOptimizations.latest('bob', id(1)),
      (await store.agentOptimizations.latest('bob', id(2)))?.id,
    ],
  },
  {
    method: 'agentOptimizations.inFlight',
    name: 'the newest queued or running pass',
    fixture,
    run: async (store) => [
      await store.agentOptimizations.inFlight(id(1)),
      await store.agentOptimizations.inFlight(id(2)),
      await store.agentOptimizations.inFlight(id(9)),
    ],
  },
  {
    method: 'agentOptimizations.claim',
    name: 'queued to running once, counting the attempt',
    fixture,
    run: async (store) => [
      await store.agentOptimizations.claim(id(15)),
      await store.agentOptimizations.claim(id(15)),
      await store.agentOptimizations.claim(id(11)),
      (await store.agentOptimizations.find('ann', id(15)))?.attempts,
    ],
  },
  {
    method: 'agentOptimizations.finish',
    name: 'success clears the error; failure keeps the report',
    fixture,
    run: async (store) => {
      await store.agentOptimizations.finish(id(12), {
        status: 'succeeded',
        result: { summary: 'better' },
        inputTokens: 10,
        outputTokens: 2,
      });
      await store.agentOptimizations.finish(id(11), {
        status: 'failed',
        error: 'late',
        detail: null,
      });
      return [
        settled(await store.agentOptimizations.find('ann', id(12))),
        settled(await store.agentOptimizations.find('ann', id(11))),
      ];
    },
  },
  {
    method: 'agentOptimizations.markApplied',
    name: 'the draft id joins the result; an empty result becomes one',
    fixture,
    run: async (store) => {
      await store.agentOptimizations.markApplied('ann', id(11), 'draft-1');
      await store.agentOptimizations.markApplied('ann', id(13), 'draft-2');
      await store.agentOptimizations.markApplied('ann', id(14), 'draft-3');
      return [
        settled(await store.agentOptimizations.find('ann', id(11))),
        settled(await store.agentOptimizations.find('ann', id(13))),
        settled(await store.agentOptimizations.find('bob', id(14))),
      ];
    },
  },
  {
    method: 'agentOptimizations.delete',
    name: 'removes one pass',
    fixture,
    run: async (store) => {
      await store.agentOptimizations.delete(id(13));
      return [
        await store.agentOptimizations.find('ann', id(13)),
        await store.agentOptimizations.inFlight(id(1)),
      ];
    },
  },
];
