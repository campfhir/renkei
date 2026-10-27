import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-13${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function message(
  n: number,
  type: string,
  payload: unknown,
  extra: { status?: string; ordering_key?: string; source?: string; minute?: number } = {}
) {
  return {
    id: id(n),
    source: extra.source ?? 'knowledge:jira',
    type,
    payload: JSON.stringify(payload),
    ordering_key: extra.ordering_key ?? null,
    status: extra.status ?? 'pending',
    created_at: at(extra.minute ?? n),
  };
}

const fixture = {
  embedding_jobs: [
    message(1, 'ingest.object', { provider: 'jira', metadata: { project: 'ENG' } }),
    message(2, 'ingest.object', { provider: 'jira', metadata: { project: 'OPS' } }),
    message(
      3,
      'ingest.object',
      { provider: 'jira', metadata: { project: 'ENG' } },
      {
        status: 'processing',
      }
    ),
    message(4, 'ingest.document', { provider: 'sharepoint', scopeKey: 'drive-1', n: 7 }),
    message(5, 'ingest.object', { provider: 'confluence', metadata: { project: 'ENG' } }),
    message(6, 'reindex.batch', { runId: 'r' }, { ordering_key: 'reindex/r', minute: 1 }),
  ],
};

export const queueScenarios: Scenario<DataStore>[] = [
  {
    method: 'queues.enqueue',
    name: 'plain and coalesced messages',
    fixture,
    run: async (store) => {
      await store.queues.enqueue('agent_jobs', {
        source: 'agents:a',
        type: 'run',
        payload: { runId: 'x' },
        orderingKey: 'agent:a',
      });
      await store.queues.enqueue('embedding_jobs', {
        source: 'knowledge:jira',
        type: 'reindex.batch',
        payload: { runId: 'r', again: true },
        orderingKey: 'reindex/r',
        coalesce: true,
      });
      await store.queues.enqueue('embedding_jobs', {
        source: 'knowledge:jira',
        type: 'reindex.batch',
        payload: { runId: 's' },
        orderingKey: 'reindex/s',
        coalesce: true,
      });
      await store.queues.enqueue('events', {
        source: 'github',
        type: 'push',
        payload: [1, 2],
        orderingKey: null,
        coalesce: true,
      });
      const pending = async (table: 'agent_jobs' | 'embedding_jobs' | 'events') =>
        (await store.queues.listPending(table)).map((m) => [m.type, m.payload, m.orderingKey]);
      return {
        agents: await pending('agent_jobs'),
        embedding: (await pending('embedding_jobs')).filter((m) => m[0] === 'reindex.batch'),
        events: await pending('events'),
      };
    },
  },
  {
    method: 'queues.discardPending',
    name: 'pending rows matching every path, nested and top level',
    fixture,
    run: async (store) => [
      await store.queues.discardPending('embedding_jobs', 'ingest.object', [
        { path: ['provider'], value: 'jira' },
        { path: ['metadata', 'project'], value: 'ENG' },
      ]),
      await store.queues.discardPending('embedding_jobs', 'ingest.document', [
        { path: ['scopeKey'], value: 'drive-1' },
        { path: ['n'], value: '7' },
      ]),
      await store.queues.discardPending('embedding_jobs', 'ingest.object', [
        { path: ['metadata', 'missing'], value: 'x' },
      ]),
      await store.queues.discardPending('embedding_jobs', 'ingest.object', []).then(
        () => 'accepted',
        () => 'refused'
      ),
      (await store.queues.listPending('embedding_jobs')).map((m) => m.payload),
    ],
  },
  {
    method: 'queues.listPending',
    name: 'pending only, oldest first, ties by id',
    fixture,
    run: async (store) => [
      await store.queues.listPending('embedding_jobs'),
      await store.queues.listPending('batch_job_messages'),
    ],
  },
  {
    method: 'queues.discardAgentRunJobs',
    name: "the run's live rows skipped, its dead letters gone, other runs untouched",
    fixture: {
      agent_jobs: [
        { ...message(21, 'run', { runId: 'r1' }, { source: 'agents:a' }), locked_at: null },
        {
          ...message(22, 'run', { runId: 'r1' }, { source: 'agents:a', status: 'processing' }),
          locked_at: at(22),
        },
        message(23, 'run', { runId: 'r1' }, { source: 'agents:a', status: 'done' }),
        message(24, 'run', { runId: 'r2' }, { source: 'agents:a' }),
      ],
      agent_jobs_dead_letters: [
        { id: id(31), source: 'agents:a', type: 'run', payload: JSON.stringify({ runId: 'r1' }) },
        { id: id(32), source: 'agents:a', type: 'run', payload: JSON.stringify({ runId: 'r2' }) },
      ],
    },
    run: async (store) => [
      await store.queues.discardAgentRunJobs('r1'),
      await store.queues.discardAgentRunJobs('r1'),
      await store.queues.discardAgentRunJobs('none'),
      (await store.queues.listPending('agent_jobs')).map((m) => m.payload),
    ],
  },
  {
    method: 'queues.hasLiveAgentRunJob',
    name: 'pending or processing rows of the run only',
    fixture: {
      agent_jobs: [
        message(41, 'run', { runId: 'r1' }, { source: 'agents:a', status: 'done' }),
        message(42, 'run', { runId: 'r2' }, { source: 'agents:a', status: 'processing' }),
        message(43, 'run', { runId: 'r3' }, { source: 'agents:a' }),
        message(44, 'run', { other: 'r4' }, { source: 'agents:a' }),
      ],
    },
    run: async (store) =>
      Promise.all(['r1', 'r2', 'r3', 'r4', 'none'].map((r) => store.queues.hasLiveAgentRunJob(r))),
  },
];
