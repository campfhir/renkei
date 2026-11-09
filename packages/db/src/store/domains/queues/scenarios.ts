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
    method: 'queues.listAgentJobs',
    name: 'one agent’s pending and processing jobs, oldest first, ties by id, limited',
    fixture: {
      agent_jobs: [
        {
          ...live(201, 'agents:a', {
            minute: 1,
            status: 'processing',
            attempts: 47,
            locked_at: PAST,
            payload: { runId: 'run-1' },
          }),
          type: 'run',
          last_error: 'stuck',
        },
        { ...live(202, 'agents:a', { minute: 2, payload: { runId: 'run-2' } }), type: 'run' },
        {
          ...live(203, 'agents:a', { minute: 2, run_after: FUTURE, payload: { batchId: 'b-1' } }),
          type: 'actions',
        },
        { ...live(204, 'agents:a', { minute: 3, status: 'processed' }), type: 'run' },
        { ...live(205, 'agents:b', { minute: 0, payload: { runId: 'run-9' } }), type: 'run' },
      ],
    },
    run: async (store) => [
      await store.queues.listAgentJobs('a', 10),
      await store.queues.listAgentJobs('a', 1),
      await store.queues.listAgentJobs('nobody', 10),
    ],
  },
  {
    method: 'queues.listAgentDeadLetters',
    name: 'one agent’s dead letters, most recently dead first, ties by id descending',
    fixture: {
      agent_jobs_dead_letters: [
        {
          id: id(211),
          source: 'agents:a',
          type: 'run',
          payload: { runId: 'run-1' },
          attempts: 3,
          last_error: 'key service unavailable',
          created_at: at(1),
          dead_at: at(20),
        },
        {
          id: id(212),
          source: 'agents:a',
          type: 'actions',
          payload: { batchId: 'b-1' },
          attempts: 5,
          last_error: 'gave up',
          created_at: at(2),
          dead_at: at(20),
        },
        {
          id: id(213),
          source: 'agents:a',
          type: 'run',
          payload: { runId: 'run-2' },
          attempts: 3,
          last_error: null,
          created_at: at(3),
          dead_at: at(10),
        },
        {
          id: id(214),
          source: 'agents:b',
          type: 'run',
          payload: { runId: 'run-9' },
          attempts: 3,
          last_error: null,
          created_at: at(4),
          dead_at: at(30),
        },
      ],
    },
    run: async (store) => [
      await store.queues.listAgentDeadLetters('a', 10),
      await store.queues.listAgentDeadLetters('a', 2),
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
      method: 'queues.claim',
      name: 'a lease that expired on its last allowed delivery is dead-lettered, freeing its key',
      fixture: {
        agent_jobs: [
          // Its consumer died on delivery 3 of 3 and never failed it.
          live(141, 'agents:a', {
            minute: 1,
            status: 'processing',
            locked_at: PAST,
            attempts: 3,
            ordering_key: 'agent:a',
          }),
          // The agent's next run, held behind it by the key until now.
          live(142, 'agents:a', { minute: 2, ordering_key: 'agent:a' }),
          // Expired too, but with deliveries left: reclaimed as before.
          live(143, 'agents:b', { minute: 3, status: 'processing', locked_at: PAST, attempts: 2 }),
          // Spent, but outside the claim's sources: left for its own consumer.
          live(144, 'agents:c', { minute: 4, status: 'processing', locked_at: PAST, attempts: 3 }),
        ],
      },
      run: async (store) => {
        const budget = { ...STALE, maxAttempts: 3, sources: ['agents:a', 'agents:b'] };
        const claims = [
          await store.queues.claim('agent_jobs', budget),
          await store.queues.claim('agent_jobs', budget),
          await store.queues.claim('agent_jobs', budget),
        ];
        return {
          claims,
          dead: (await store.queues.listDeadLetters('agent_jobs', 10)).map(
            ({ deadAt: _deadAt, ...rest }) => rest
          ),
          outsideSources: await state(store, 'agent_jobs', 144),
          // Without a budget, a stale lease is reclaimed however often it expired.
          unbudgeted: await store.queues.claim('agent_jobs', STALE),
        };
      },
    },
    {
      method: 'queues.complete',
      name: 'with attempts, only the delivery still holding the lease is acked',
      fixture: {
        events: [
          live(151, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 2 }),
          // Reclaimed by another consumer since the late ack's delivery.
          live(152, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 3 }),
          live(153, 'webex', { attempts: 1 }),
        ],
      },
      run: async (store) => [
        await store.queues.complete('events', id(151), 'processed', { attempts: 2 }),
        await store.queues.complete('events', id(152), 'processed', { attempts: 2 }),
        await store.queues.complete('events', id(153), 'skipped', { attempts: 1 }),
        await store.queues.complete('events', id(199), 'processed', { attempts: 1 }),
        await state(store, 'events', 151),
        await state(store, 'events', 152),
        await state(store, 'events', 153),
      ],
    },
    {
      method: 'queues.extendLease',
      name: 'renewed only while held at that attempt count; a renewed lease is not reclaimed',
      fixture: {
        events: [
          live(161, 'webex', { minute: 1, status: 'processing', locked_at: PAST, attempts: 2 }),
          live(162, 'webex', { minute: 2, status: 'processing', locked_at: PAST, attempts: 3 }),
          live(163, 'webex', { minute: 3, attempts: 2, run_after: FUTURE }),
        ],
      },
      run: async (store) => [
        await store.queues.extendLease('events', id(161), 2),
        await store.queues.extendLease('events', id(162), 2),
        await store.queues.extendLease('events', id(163), 2),
        await store.queues.extendLease('events', id(199), 1),
        await state(store, 'events', 163),
        // 161's lease is fresh again; 162's is still expired.
        await store.queues.claim('events', STALE),
        await store.queues.claim('events', STALE),
      ],
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
      method: 'queues.retry',
      name: 'with attempts, a consumer that lost its lease cannot put the row back to pending',
      fixture: {
        events: [
          live(171, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 2 }),
          live(172, 'webex', { status: 'processing', locked_at: FUTURE, attempts: 3 }),
        ],
      },
      run: async (store) => [
        await store.queues.retry('events', id(171), 'slow upstream', 60, { attempts: 2 }),
        await store.queues.retry('events', id(172), 'late nack', 60, { attempts: 2 }),
        await state(store, 'events', 171),
        await state(store, 'events', 172),
      ],
    },
    {
      method: 'queues.deadLetter',
      name: 'with attempts, a consumer that lost its lease cannot move the row or free its key',
      fixture: {
        events: [
          live(181, 'webex', {
            minute: 1,
            status: 'processing',
            locked_at: FUTURE,
            attempts: 3,
            ordering_key: 'k',
          }),
          live(182, 'webex', { minute: 2, ordering_key: 'k' }),
          live(183, 'webex', { minute: 3, status: 'processing', locked_at: FUTURE, attempts: 1 }),
        ],
      },
      run: async (store) => [
        await store.queues.deadLetter('events', id(181), 'late nack', { attempts: 2 }),
        await store.queues.deadLetter('events', id(183), 'gave up', { attempts: 1 }),
        await state(store, 'events', 181),
        (await store.queues.listDeadLetters('events', 10)).map((d) => [d.id, d.lastError]),
        // 181 still holds key k, so 182 waits.
        await store.queues.claim('events', STALE),
      ],
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
