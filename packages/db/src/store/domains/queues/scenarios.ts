import type { Scenario } from '../../domain';
import { toJson } from '../../memory/tables';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-13${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

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
    payload: toJson(payload),
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

const PAST = new Date(Date.UTC(2026, 0, 1));
const FUTURE = new Date(Date.UTC(2099, 0, 1));
const STALE = { staleClaimMinutes: 10 };

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
        { id: id(31), source: 'agents:a', type: 'run', payload: { runId: 'r1' } },
        { id: id(32), source: 'agents:a', type: 'run', payload: { runId: 'r2' } },
      ],
    },
    run: async (store) => [
      await store.queues.discardAgentRunJobs('r1'),
      await store.queues.discardAgentRunJobs('r1'),
      await store.queues.discardAgentRunJobs('none'),
      (await store.queues.listPending('agent_jobs')).map((m) => m.payload),
    ],
  },
  ...consumerScenarios(),
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

/** A live row with every consumer-side column named. */
function live(
  n: number,
  source: string,
  extra: {
    status?: string;
    ordering_key?: string;
    minute?: number;
    run_after?: Date;
    locked_at?: Date | null;
    attempts?: number;
    payload?: unknown;
  } = {}
) {
  return {
    ...message(n, 'msg', extra.payload ?? { n }, {
      source,
      status: extra.status,
      ordering_key: extra.ordering_key,
      minute: extra.minute,
    }),
    run_after: extra.run_after ?? PAST,
    locked_at: extra.locked_at ?? null,
    attempts: extra.attempts ?? 0,
  };
}

function deadRow(n: number, minute: number, extra: { ordering_key?: string } = {}) {
  return {
    id: id(n),
    source: 'webex',
    type: 'msg',
    payload: { n },
    ordering_key: extra.ordering_key ?? null,
    attempts: 5,
    last_error: `boom ${n}`,
    created_at: at(n % 60),
    dead_at: at(minute),
  };
}

/** A message's consumer-visible state, timestamps reduced to what a test can know. */
async function state(store: DataStore, table: 'events' | 'agent_jobs', n: number) {
  const row = await store.queues.find(table, id(n));
  if (!row) return null;
  return {
    status: row.status,
    attempts: row.attempts,
    payload: row.payload,
    lastError: row.lastError,
    locked: row.lockedAt !== null,
    dueNow: row.runAfter.getTime() <= Date.now(),
  };
}

function consumerScenarios(): Scenario<DataStore>[] {
  const claimFixture = {
    events: [
      live(41, 'webex', { minute: 1, ordering_key: 'k1' }),
      // Behind 41 on its key.
      live(42, 'webex', { minute: 2, ordering_key: 'k1' }),
      // Backing off.
      live(43, 'github', { minute: 3, run_after: FUTURE }),
      // A dead consumer's orphan: lease long expired.
      live(44, 'github', { minute: 4, status: 'processing', locked_at: PAST, attempts: 2 }),
      // Leased and live; its key-mate 46 waits behind it.
      live(45, 'zoom', { minute: 0, status: 'processing', locked_at: FUTURE, ordering_key: 'k2' }),
      live(46, 'zoom', { minute: 6, ordering_key: 'k2' }),
      live(47, 'webex', { minute: 0, status: 'processed' }),
      // Same created_at: the lower id first.
      live(49, 'webex', { minute: 8 }),
      live(48, 'webex', { minute: 8 }),
    ],
  };
  return [
    {
      method: 'queues.claim',
      name: 'oldest deliverable first: keys serial, leases honoured, ties by id, sources',
      fixture: claimFixture,
      run: async (store) => {
        const claims: unknown[] = [];
        claims.push(await store.queues.claim('events', { ...STALE, sources: ['github'] }));
        claims.push(await store.queues.claim('events', { ...STALE, sources: ['nobody'] }));
        for (let i = 0; i < 4; i += 1) claims.push(await store.queues.claim('events', STALE));
        await store.queues.complete('events', id(41), 'processed');
        claims.push(await store.queues.claim('events', STALE));
        claims.push(await store.queues.claim('agent_jobs', STALE));
        return { claims, after: await state(store, 'events', 41) };
      },
    },
    {
      method: 'queues.claim',
      name: 'fair across sources: a key-blocked pick falls back, nothing due is null',
      fixture: {
        agent_jobs: [
          live(51, 'agents:a', {
            minute: 1,
            status: 'processing',
            locked_at: FUTURE,
            ordering_key: 'agent:a',
          }),
          live(52, 'agents:a', { minute: 2, ordering_key: 'agent:a' }),
          live(53, 'agents:b', { minute: 3 }),
        ],
      },
      run: async (store) => {
        const fair = { ...STALE, fairAcrossSources: true };
        return [
          await store.queues.claim('agent_jobs', fair),
          await store.queues.claim('agent_jobs', fair),
          await store.queues.claim('batch_job_messages', fair),
          await state(store, 'agent_jobs', 53),
        ];
      },
    },
    {
      method: 'queues.complete',
      name: 'processed or skipped, unlocked, payload blanked only when asked',
      fixture: {
        events: [
          live(61, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 1 }),
          live(62, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 1 }),
          live(63, 'webex', { payload: { keep: 'me' } }),
        ],
      },
      run: async (store) => {
        await store.queues.complete('events', id(61), 'processed');
        await store.queues.complete('events', id(62), 'skipped', { clearPayload: true });
        await store.queues.complete('events', id(99), 'processed');
        return [
          await state(store, 'events', 61),
          await state(store, 'events', 62),
          await state(store, 'events', 63),
          await store.queues.claim('events', STALE),
        ];
      },
    },
    {
      method: 'queues.release',
      name: 'back to pending uncounted, only while still held at that attempt count',
      fixture: {
        events: [
          live(71, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 2 }),
          live(72, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 3 }),
          live(73, 'webex', { attempts: 1, run_after: FUTURE }),
        ],
      },
      run: async (store) => {
        await store.queues.release('events', id(71), 2);
        await store.queues.release('events', id(72), 2);
        await store.queues.release('events', id(73), 1);
        return [
          await state(store, 'events', 71),
          await state(store, 'events', 72),
          await state(store, 'events', 73),
        ];
      },
    },
    {
      method: 'queues.retry',
      name: 'pending again with the error, not due until the delay passes',
      fixture: {
        events: [
          live(81, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 1 }),
          live(82, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 1 }),
        ],
      },
      run: async (store) => {
        await store.queues.retry('events', id(81), 'upstream 503', 3600);
        return [
          await state(store, 'events', 81),
          await state(store, 'events', 82),
          await store.queues.claim('events', STALE),
        ];
      },
    },
    {
      method: 'queues.deadLetter',
      name: 'the live row moves with its key and attempts, unblocking its key-mate',
      fixture: {
        events: [
          live(91, 'webex', {
            minute: 1,
            status: 'processing',
            locked_at: FUTURE,
            attempts: 5,
            ordering_key: 'k',
          }),
          live(92, 'webex', { minute: 2, ordering_key: 'k' }),
        ],
      },
      run: async (store) => {
        const blocked = await store.queues.claim('events', STALE);
        await store.queues.deadLetter('events', id(91), 'gave up');
        await store.queues.deadLetter('events', id(99), 'nothing there');
        const dead = (await store.queues.listDeadLetters('events', 10)).map(
          ({ deadAt: _deadAt, ...rest }) => rest
        );
        return {
          blocked,
          live: await state(store, 'events', 91),
          dead,
          next: await store.queues.claim('events', STALE),
        };
      },
    },
    {
      method: 'queues.find',
      name: 'every column of one live message; unknown is null',
      fixture: {
        agent_jobs: [
          {
            ...live(101, 'agents:a', { ordering_key: 'agent:a', attempts: 2, minute: 7 }),
            last_error: 'once',
          },
        ],
      },
      run: async (store) => [
        await store.queues.find('agent_jobs', id(101)),
        await store.queues.find('agent_jobs', id(102)),
        await store.queues.find('events', id(101)),
      ],
    },
    {
      method: 'queues.listDeadLetters',
      name: 'most recently dead first, ties by id descending, limited, per queue',
      fixture: {
        events_dead_letters: [
          deadRow(111, 5),
          deadRow(112, 9, { ordering_key: 'k' }),
          deadRow(113, 9),
          deadRow(114, 1),
        ],
      },
      run: async (store) => [
        await store.queues.listDeadLetters('events', 10),
        await store.queues.listDeadLetters('events', 2),
        await store.queues.listDeadLetters('embedding_jobs', 10),
      ],
    },
    {
      method: 'queues.requeueDeadLetters',
      name: 'known ids move back pending with a fresh budget; unknown ones are skipped',
      fixture: {
        events_dead_letters: [deadRow(121, 1, { ordering_key: 'k' }), deadRow(122, 2)],
      },
      run: async (store) => [
        await store.queues.requeueDeadLetters('events', []),
        await store.queues.requeueDeadLetters('events', [id(121), id(129)]),
        await state(store, 'events', 121),
        await store.queues.listPending('events'),
        (await store.queues.listDeadLetters('events', 10)).map((d) => d.id),
        await store.queues.claim('events', STALE),
      ],
    },
    {
      method: 'queues.purgeDeadLetters',
      name: 'gone for good; unknown and empty count nothing',
      fixture: {
        events_dead_letters: [deadRow(131, 1), deadRow(132, 2)],
        embedding_jobs_dead_letters: [deadRow(133, 3)],
      },
      run: async (store) => [
        await store.queues.purgeDeadLetters('events', []),
        await store.queues.purgeDeadLetters('events', [id(131), id(133)]),
        (await store.queues.listDeadLetters('events', 10)).map((d) => d.id),
        (await store.queues.listDeadLetters('embedding_jobs', 10)).map((d) => d.id),
      ],
    },
  ];
}
