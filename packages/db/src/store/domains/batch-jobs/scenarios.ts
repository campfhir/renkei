import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { BatchJobRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const SCHEDULE = id(900);
const MISSING = id(999);

function batch(n: number, subject: string, minute: number, fields: Record<string, unknown> = {}) {
  return {
    id: id(n),
    subject,
    name: `Batch ${n}`,
    kind: 'document-ocr-pipeline',
    config: JSON.stringify({ shareId: 'share-1', path: `/in/${n}` }),
    created_at: at(minute),
    ...fields,
  };
}

function item(n: number, batchId: string, minute: number, fields: Record<string, unknown> = {}) {
  return {
    id: id(n),
    batch_id: batchId,
    payload: JSON.stringify({ documentKey: `doc-${n}` }),
    created_at: at(minute),
    ...fields,
  };
}

const SHARE = id(800);
const OTHER_SHARE = id(801);

const share = (n: string) => ({
  id: n,
  name: `Share ${n.slice(-3)}`,
  protocol: 'smb',
  host: 'files.example.test',
  case_insensitive: true,
});

const processed = (n: number, shareId: string, hash: string, path: string) => ({
  id: id(700 + n),
  share_id: shareId,
  content_hash: hash,
  path,
  size: 10 * n,
  modified_at: n === 3 ? null : at(n),
});

const ledger = {
  file_shares: [share(SHARE), share(OTHER_SHARE)],
  batch_jobs: [{ id: id(1), subject: 'ann', kind: 'document-ocr-pipeline' }],
  batch_processed_files: [
    processed(1, SHARE, 'hash-a', '/in/a.pdf'),
    processed(2, SHARE, 'hash-b', '/in/b.pdf'),
    processed(3, SHARE, 'hash-c', '/in/c.pdf'),
    processed(4, OTHER_SHARE, 'hash-c', '/in/a.pdf'),
  ],
};

const fixture = {
  batch_job_schedules: [
    {
      id: SCHEDULE,
      subject: 'ann',
      name: 'Nightly',
      kind: 'document-ocr-pipeline',
      next_run_at: at(60),
    },
  ],
  batch_jobs: [
    batch(1, 'ann', 1, { status: 'succeeded', total: 2, succeeded: 2 }),
    batch(2, 'ann', 3, { status: 'running', total: 4, succeeded: 1, schedule_id: SCHEDULE }),
    batch(3, 'ann', 3, { status: 'queued' }),
    batch(4, 'ann', 5, { status: 'discovering', schedule_id: SCHEDULE }),
    batch(5, 'ann', 2, { status: 'failed', last_error: 'boom', config: '[]' }),
    batch(6, 'bob', 6, { status: 'running', total: 1 }),
    batch(7, 'ann', 7, { status: 'running', total: 3, succeeded: 1, failed: 1, skipped: 0 }),
    batch(8, 'ann', 8, { status: 'canceled' }),
  ],
  batch_job_items: [
    item(11, id(2), 1, { status: 'succeeded', result: JSON.stringify({ sandboxFileId: 'f-1' }) }),
    item(12, id(2), 3),
    item(13, id(2), 2, { status: 'failed', error: 'OCR failed' }),
    item(14, id(2), 2, {
      status: 'skipped',
      result: JSON.stringify({ reason: 'already-processed' }),
    }),
    item(15, id(2), 4, { status: 'processing' }),
    item(16, id(6), 1),
  ],
};

/** A batch without the stamps NOW() set — those differ between the two stores by design. */
function settled(record: BatchJobRecord | undefined) {
  if (!record) return record;
  const { startedAt, finishedAt, createdAt: _createdAt, ...rest } = record;
  return { ...rest, started: startedAt !== null, finished: finishedAt !== null };
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ ok: value }),
    (error: { code?: string }) => ({ refused: error.code ?? 'error' })
  );

export const batchJobScenarios: Scenario<DataStore>[] = [
  {
    method: 'batchJobs.create',
    name: 'defaults, a schedule link, and refusals',
    fixture,
    run: async (store) => {
      const made = await store.batchJobs.create({
        id: id(20),
        subject: 'ann',
        name: 'Fresh',
        kind: 'document-ocr-pipeline',
        config: { shareId: 'share-2', grouping: { strategy: 'whole-file' } },
        scheduleId: SCHEDULE,
      });
      const generated = await store.batchJobs.create({
        subject: 'ann',
        name: 'No id',
        kind: 'k',
        config: {},
      });
      return {
        made: settled(made),
        reread: settled(await store.batchJobs.get(id(20))),
        generatedHasId: typeof generated.id === 'string' && generated.id.length === 36,
        generatedSchedule: generated.scheduleId,
        duplicate: await outcome(
          store.batchJobs.create({ id: id(20), subject: 'ann', name: 'x', kind: 'k', config: {} })
        ),
        noSchedule: await outcome(
          store.batchJobs.create({
            subject: 'ann',
            name: 'x',
            kind: 'k',
            config: {},
            scheduleId: MISSING,
          })
        ),
      };
    },
  },
  {
    method: 'batchJobs.get',
    name: 'by id, config as stored, missing and malformed ids',
    fixture,
    run: async (store) => [
      await store.batchJobs.get(id(1)),
      await store.batchJobs.get(id(5)),
      await store.batchJobs.get(id(6)),
      await store.batchJobs.get(MISSING),
      await store.batchJobs.get(id(2).toUpperCase()),
      await outcome(store.batchJobs.get('not-a-uuid')),
    ],
  },
  {
    method: 'batchJobs.list',
    name: 'newest first, ties by id, filtered and bounded, own rows only',
    fixture,
    run: async (store) => {
      const ids = (rows: BatchJobRecord[]) => rows.map((r) => r.id);
      return {
        all: await store.batchJobs.list('ann'),
        limited: ids(await store.batchJobs.list('ann', { limit: 3 })),
        zeroLimit: ids(await store.batchJobs.list('ann', { limit: 0 })),
        running: ids(await store.batchJobs.list('ann', { status: 'running' })),
        bySchedule: ids(await store.batchJobs.list('ann', { scheduleId: SCHEDULE })),
        scheduleAndStatus: ids(
          await store.batchJobs.list('ann', { scheduleId: SCHEDULE, status: 'running' })
        ),
        bob: ids(await store.batchJobs.list('bob')),
        nobody: await store.batchJobs.list('nobody'),
        noMatch: await store.batchJobs.list('ann', { status: 'partial' }),
      };
    },
  },
  {
    method: 'batchJobs.beginDiscovery',
    name: 'only a queued batch is claimed, once',
    fixture,
    run: async (store) => [
      settled(await store.batchJobs.beginDiscovery(id(3))),
      settled(await store.batchJobs.beginDiscovery(id(3))),
      settled(await store.batchJobs.beginDiscovery(id(2))),
      settled(await store.batchJobs.beginDiscovery(MISSING)),
      settled(await store.batchJobs.get(id(3))),
    ],
  },
  {
    method: 'batchJobs.fail',
    name: 'any live status fails once; terminal ones stay',
    fixture,
    run: async (store) => [
      settled(await store.batchJobs.fail(id(4), 'worker restarted mid-discovery')),
      settled(await store.batchJobs.fail(id(4), 'again')),
      settled(await store.batchJobs.fail(id(3), 'queued one')),
      settled(await store.batchJobs.fail(id(1), 'too late')),
      settled(await store.batchJobs.fail(id(8), 'canceled already')),
      settled(await store.batchJobs.get(id(1))),
    ],
  },
  {
    method: 'batchJobs.completeEmpty',
    name: 'total becomes skipped, counter added to; terminal ones stay',
    fixture,
    run: async (store) => [
      settled(await store.batchJobs.completeEmpty(id(4), 3)),
      settled(await store.batchJobs.completeEmpty(id(3), 0)),
      settled(await store.batchJobs.completeEmpty(id(5), 2)),
      settled(await store.batchJobs.get(id(4))),
    ],
  },
  {
    method: 'batchJobs.activate',
    name: 'running with a total, skipped added, unguarded',
    fixture,
    run: async (store) => [
      settled(await store.batchJobs.activate(id(4), 5, 2)),
      settled(await store.batchJobs.activate(id(4), 6, 1)),
      settled(await store.batchJobs.activate(MISSING, 1, 0)),
    ],
  },
  {
    method: 'batchJobs.addCounts',
    name: 'counters add up across calls',
    fixture,
    run: async (store) => [
      settled(await store.batchJobs.addCounts(id(7), { succeeded: 1, failed: 0, skipped: 0 })),
      settled(await store.batchJobs.addCounts(id(7), { succeeded: 0, failed: 2, skipped: 3 })),
      settled(await store.batchJobs.addCounts(MISSING, { succeeded: 1, failed: 0, skipped: 0 })),
      settled(await store.batchJobs.get(id(6))),
    ],
  },
  {
    method: 'batchJobs.finishRunning',
    name: 'only a running batch flips, and only once',
    fixture,
    run: async (store) => [
      settled(await store.batchJobs.finishRunning(id(7), 'partial')),
      settled(await store.batchJobs.finishRunning(id(7), 'succeeded')),
      settled(await store.batchJobs.finishRunning(id(3), 'succeeded')),
      settled(await store.batchJobs.get(id(7))),
    ],
  },
  {
    method: 'batchJobs.insertItem',
    name: 'pending by default, a skipped one with its result, refusals',
    fixture,
    run: async (store) => {
      const pending = await store.batchJobs.insertItem(id(3), {
        id: id(30),
        payload: { documentKey: 'a', files: ['/in/a.pdf'] },
      });
      const skipped = await store.batchJobs.insertItem(id(3), {
        id: id(31),
        payload: { documentKey: 'b' },
        status: 'skipped',
        result: { skipped: true, reason: 'already-processed' },
      });
      const generated = await store.batchJobs.insertItem(id(3), { payload: {} });
      return {
        pending,
        skipped,
        generated: { ...generated, id: generated.id.length },
        listed: (await store.batchJobs.listItems(id(3))).length,
        noBatch: await outcome(store.batchJobs.insertItem(MISSING, { payload: {} })),
        duplicate: await outcome(store.batchJobs.insertItem(id(3), { id: id(30), payload: {} })),
      };
    },
  },
  {
    method: 'batchJobs.getItem',
    name: 'by id, payload and result as stored',
    fixture,
    run: async (store) => [
      await store.batchJobs.getItem(id(11)),
      await store.batchJobs.getItem(id(14)),
      await store.batchJobs.getItem(MISSING),
      await outcome(store.batchJobs.getItem('nope')),
    ],
  },
  {
    method: 'batchJobs.claimItem',
    name: 'only a pending item is claimed, once',
    fixture,
    run: async (store) => [
      await store.batchJobs.claimItem(id(12)),
      await store.batchJobs.claimItem(id(12)),
      await store.batchJobs.claimItem(id(11)),
      await store.batchJobs.claimItem(MISSING),
    ],
  },
  {
    method: 'batchJobs.setItemOutcome',
    name: 'overwrites status, result and error',
    fixture,
    run: async (store) => {
      await store.batchJobs.setItemOutcome(id(15), {
        status: 'succeeded',
        result: { sandboxFileId: 'f-9', pages: [1, 2] },
        error: null,
      });
      await store.batchJobs.setItemOutcome(id(11), {
        status: 'failed',
        result: null,
        error: 'worker restarted mid-item',
      });
      await store.batchJobs.setItemOutcome(MISSING, { status: 'failed', result: null, error: 'x' });
      return [await store.batchJobs.getItem(id(15)), await store.batchJobs.getItem(id(11))];
    },
  },
  {
    method: 'batchJobs.listItems',
    name: 'oldest first, ties by id, filtered and bounded, one batch only',
    fixture,
    run: async (store) => ({
      all: await store.batchJobs.listItems(id(2)),
      limited: (await store.batchJobs.listItems(id(2), { limit: 2 })).map((i) => i.id),
      failed: (await store.batchJobs.listItems(id(2), { status: 'failed' })).map((i) => i.id),
      pendingLimited: (await store.batchJobs.listItems(id(2), { status: 'pending', limit: 1 })).map(
        (i) => i.id
      ),
      other: (await store.batchJobs.listItems(id(6))).map((i) => i.id),
      empty: await store.batchJobs.listItems(id(1)),
      missing: await store.batchJobs.listItems(MISSING),
    }),
  },
  {
    method: 'batchJobs.findProcessedByPath',
    name: 'rows at these paths on this share, by path',
    fixture: ledger,
    run: async (store) => [
      await store.batchJobs.findProcessedByPath(SHARE, ['/in/b.pdf', '/in/a.pdf', '/in/none.pdf']),
      await store.batchJobs.findProcessedByPath(OTHER_SHARE, ['/in/a.pdf']),
      await store.batchJobs.findProcessedByPath(SHARE, []),
    ],
  },
  {
    method: 'batchJobs.findProcessedHashes',
    name: 'known hashes on this share only, sorted',
    fixture: ledger,
    run: async (store) => [
      await store.batchJobs.findProcessedHashes(SHARE, ['hash-b', 'hash-z', 'hash-a', 'hash-c']),
      await store.batchJobs.findProcessedHashes(OTHER_SHARE, ['hash-a', 'hash-c']),
      await store.batchJobs.findProcessedHashes(SHARE, []),
    ],
  },
  {
    method: 'batchJobs.recordProcessedFiles',
    name: 'new hashes inserted, a known hash follows its moved file',
    fixture: ledger,
    run: async (store) => {
      await store.batchJobs.recordProcessedFiles(SHARE, id(1), [
        { contentHash: 'hash-a', path: '/in/moved.pdf', size: 11, modifiedAt: new Date(at(9)) },
        {
          contentHash: 'hash-new',
          path: '/in/new.pdf',
          size: 5,
          modifiedAt: null,
          documentKey: 'doc-new',
        },
      ]);
      await store.batchJobs.recordProcessedFiles(SHARE, id(1), []);
      return [
        await store.batchJobs.findProcessedByPath(SHARE, [
          '/in/a.pdf',
          '/in/moved.pdf',
          '/in/new.pdf',
        ]),
        await store.batchJobs.findProcessedHashes(SHARE, ['hash-a', 'hash-new']),
      ];
    },
  },
];
