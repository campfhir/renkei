import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-bc${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const agents = [
  { id: id(1), owner_subject: 'ann', name: 'Ann agent' },
  { id: id(2), owner_subject: 'bob', name: 'Bob agent' },
];

function run(n: number, agent: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    agent_id: id(agent),
    owner_subject: agent === 1 ? 'ann' : 'bob',
    trigger_kind: 'manual',
    status,
    waiting_until: null,
    created_at: at(n),
    updated_at: at(n),
    ...extra,
  };
}

function card(n: number, runN: number | null, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(100 + n),
    source: 'agent',
    kind: 'approval',
    title: `card ${n}`,
    summary: `card ${n}`,
    evidence: {},
    owner_subject: 'ann',
    run_id: runN === null ? null : id(runN),
    status,
    created_at: at(1),
    updated_at: at(1),
    ...extra,
  };
}

const waitingFixture = {
  agents,
  agent_runs: [
    run(11, 1, 'waiting', { waiting_until: at(20) }),
    run(12, 2, 'waiting', { waiting_until: at(10) }),
    run(13, 1, 'waiting', { waiting_until: at(10) }),
    run(14, 1, 'waiting', { waiting_until: at(90) }),
    run(15, 1, 'waiting', { waiting_until: null }),
    run(16, 1, 'running', { waiting_until: at(1) }),
    run(17, 1, 'waiting'),
    run(18, 1, 'failed'),
    run(19, 2, 'waiting', { updated_at: at(80) }),
  ],
  actionable_items: [
    card(1, 11, 'suggested'),
    card(2, 12, 'approved', { decided_at: at(5) }),
    card(3, 12, 'answered', { decided_at: at(6) }),
    card(4, 13, 'declined', { decided_at: at(40) }),
    card(5, 14, 'expired', { decided_at: at(2) }),
    card(6, 16, 'approved', { decided_at: at(2) }),
    card(7, 15, 'dismissed', { decided_at: at(2) }),
    card(8, 18, 'suggested'),
    card(9, null, 'suggested'),
  ],
};

const cardStatus = async (store: DataStore, n: number) => {
  const found = await store.agentRuns.findCard(id(100 + n), 'ann');
  return found && [n, found.status];
};

const runStatus = async (store: DataStore, n: number, agent: number) =>
  (await store.agentRuns.findStatus({ agentId: id(agent), runId: id(n) }))?.status ?? null;

export const agentRunSweepScenarios: Scenario<DataStore>[] = [
  {
    method: 'agentRuns.listDueWaiting',
    name: 'waiting runs due by now, soonest first with id ties, bounded',
    fixture: waitingFixture,
    run: async (store) => [
      await store.agentRuns.listDueWaiting(at(20), 10),
      await store.agentRuns.listDueWaiting(at(20), 1),
      await store.agentRuns.listDueWaiting(at(0), 10),
    ],
  },
  {
    method: 'agentRuns.expireWaitingCard',
    name: 'claims a suggested card once; a decided card is not claimed',
    fixture: waitingFixture,
    run: async (store) => [
      await store.agentRuns.expireWaitingCard(id(11), 'timeout'),
      await store.agentRuns.expireWaitingCard(id(11), 'timeout'),
      await store.agentRuns.expireWaitingCard(id(12), 'timeout'),
      await cardStatus(store, 1),
      await cardStatus(store, 2),
      await cardStatus(store, 8),
    ],
  },
  {
    method: 'agentRuns.listWaitingWithDecidedCard',
    name: 'one entry per decided card of a waiting run, by run then card',
    fixture: waitingFixture,
    run: async (store) => [
      await store.agentRuns.listWaitingWithDecidedCard(at(10), 10),
      await store.agentRuns.listWaitingWithDecidedCard(at(10), 1),
      await store.agentRuns.listWaitingWithDecidedCard(at(50), 10),
      await store.agentRuns.listWaitingWithDecidedCard(at(0), 10),
    ],
  },
  {
    method: 'agentRuns.listWaitingWithoutCard',
    name: 'waiting runs no card names, quiet long enough, by id',
    fixture: waitingFixture,
    run: async (store) => [
      await store.agentRuns.listWaitingWithoutCard(at(90), 10),
      await store.agentRuns.listWaitingWithoutCard(at(30), 10),
      await store.agentRuns.listWaitingWithoutCard(at(0), 10),
    ],
  },
  {
    method: 'agentRuns.expireCardsOfEndedRuns',
    name: 'suggested cards of settled runs only; live runs and run-less cards stay',
    fixture: waitingFixture,
    run: async (store) => [
      await store.agentRuns.expireCardsOfEndedRuns(),
      await store.agentRuns.expireCardsOfEndedRuns(),
      await cardStatus(store, 1),
      await cardStatus(store, 8),
      await cardStatus(store, 9),
    ],
  },
  {
    method: 'agentRuns.pruneFinishedBefore',
    name: 'settled runs only, oldest first with id ties, bounded',
    fixture: {
      agents,
      agent_runs: [
        run(21, 1, 'succeeded', { created_at: at(5) }),
        run(22, 2, 'failed', { created_at: at(3) }),
        run(23, 1, 'canceled', { created_at: at(3) }),
        run(24, 1, 'stopped', { created_at: at(4) }),
        run(25, 1, 'running', { created_at: at(1) }),
        run(26, 1, 'succeeded', { created_at: at(60) }),
      ],
    },
    run: async (store) => {
      const first = await store.agentRuns.pruneFinishedBefore(at(30), 1);
      const left = async () =>
        Promise.all(
          [
            [21, 1],
            [22, 2],
            [23, 1],
            [24, 1],
            [25, 1],
            [26, 1],
          ].map(async ([n, agent]) => runStatus(store, n, agent))
        );
      const afterFirst = await left();
      const second = await store.agentRuns.pruneFinishedBefore(at(30), 10);
      return [first, afterFirst, second, await left()];
    },
  },
  {
    method: 'agentRuns.listStaleInProgress',
    name: 'queued or running, created before the cutoff, oldest first, bounded',
    fixture: {
      agents,
      agent_runs: [
        run(31, 1, 'running', { created_at: at(5), started_at: at(6) }),
        run(32, 2, 'queued', { created_at: at(3) }),
        run(33, 1, 'queued', { created_at: at(3) }),
        run(34, 1, 'waiting', { created_at: at(1) }),
        run(35, 1, 'running', { created_at: at(70) }),
      ],
    },
    run: async (store) => [
      await store.agentRuns.listStaleInProgress(at(60), 10),
      await store.agentRuns.listStaleInProgress(at(60), 2),
      await store.agentRuns.listStaleInProgress(at(0), 10),
    ],
  },
  {
    method: 'agentRuns.failAbandoned',
    name: 'queued or running runs only, once',
    fixture: {
      agents,
      agent_runs: [run(41, 1, 'running'), run(42, 1, 'queued'), run(43, 1, 'succeeded')],
    },
    run: async (store) => {
      const failure = { errorKind: 'timeout', error: 'abandoned' };
      const outcomes = [
        await store.agentRuns.failAbandoned(id(41), failure),
        await store.agentRuns.failAbandoned(id(41), failure),
        await store.agentRuns.failAbandoned(id(42), failure),
        await store.agentRuns.failAbandoned(id(43), failure),
      ];
      const detail = await store.agentRuns.findForResume(id(41), id(1), 'ann');
      return [outcomes, detail, await runStatus(store, 42, 1), await runStatus(store, 43, 1)];
    },
  },
];
