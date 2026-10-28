import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-15${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function run(n: number, kind: string, status: string, minute: number, extra = {}) {
  return { id: id(n), kind, status, created_at: at(minute), requested_by: 'op', ...extra };
}

const fixture = {
  knowledge_reindex_runs: [
    run(1, 'embed', 'running', 1, { processed: 40, cursor: 'c-40', started_at: at(2) }),
    run(2, 'lexical', 'paused', 3, { processed: 5 }),
    run(3, 'keywords', 'failed', 3, { last_error: 'rate limited', finished_at: at(4) }),
    run(4, 'embed', 'succeeded', 0, { finished_at: at(1) }),
    run(5, 'lexical', 'queued', 5),
  ],
};

const statuses = async (store: DataStore) =>
  (await store.knowledgeReindexRuns.listRecent(10)).map((r) => [r.kind, r.status, r.lastError]);

export const knowledgeReindexRunScenarios: Scenario<DataStore>[] = [
  {
    method: 'knowledgeReindexRuns.listRecent',
    name: 'newest first, ties by id descending, bounded',
    fixture,
    run: async (store) => [
      await store.knowledgeReindexRuns.listRecent(10),
      (await store.knowledgeReindexRuns.listRecent(2)).map((r) => r.id),
    ],
  },
  {
    method: 'knowledgeReindexRuns.find',
    name: 'by id and kind',
    fixture,
    run: async (store) => [
      await store.knowledgeReindexRuns.find(id(1), 'embed'),
      await store.knowledgeReindexRuns.find(id(1), 'lexical'),
      await store.knowledgeReindexRuns.find(id(9), 'embed'),
    ],
  },
  {
    method: 'knowledgeReindexRuns.findActive',
    name: 'queued or running only',
    fixture,
    run: async (store) => [
      (await store.knowledgeReindexRuns.findActive('embed'))?.id ?? null,
      (await store.knowledgeReindexRuns.findActive('lexical'))?.id ?? null,
      await store.knowledgeReindexRuns.findActive('keywords'),
    ],
  },
  {
    method: 'knowledgeReindexRuns.create',
    name: 'a queued run with zero tallies',
    fixture,
    run: async (store) => {
      await store.knowledgeReindexRuns.create({ id: id(6), kind: 'keywords', requestedBy: 'ann' });
      const created = await store.knowledgeReindexRuns.find(id(6), 'keywords');
      return created && { ...created, createdAt: null };
    },
  },
  {
    method: 'knowledgeReindexRuns.pause',
    name: 'active runs of the kind only',
    fixture,
    run: async (store) => [
      await store.knowledgeReindexRuns.pause(id(1), 'embed'),
      await store.knowledgeReindexRuns.pause(id(1), 'embed'),
      await store.knowledgeReindexRuns.pause(id(5), 'embed'),
      await store.knowledgeReindexRuns.pause(id(4), 'embed'),
      await statuses(store),
    ],
  },
  {
    method: 'knowledgeReindexRuns.resume',
    name: 'paused or failed back to queued, error cleared',
    fixture,
    run: async (store) => [
      await store.knowledgeReindexRuns.resume(id(2)),
      await store.knowledgeReindexRuns.resume(id(3)),
      await store.knowledgeReindexRuns.resume(id(1)),
      await store.knowledgeReindexRuns.find(id(3), 'keywords'),
      await statuses(store),
    ],
  },
  {
    method: 'knowledgeReindexRuns.markFailed',
    name: 'whatever the status',
    fixture,
    run: async (store) => {
      await store.knowledgeReindexRuns.markFailed(id(5), 'could not enqueue');
      await store.knowledgeReindexRuns.markFailed(id(9), 'nobody');
      return statuses(store);
    },
  },
  {
    method: 'knowledgeReindexRuns.get',
    name: 'by id alone, any kind; missing',
    fixture,
    run: async (store) => [
      await store.knowledgeReindexRuns.get(id(2)),
      await store.knowledgeReindexRuns.get(id(3)),
      await store.knowledgeReindexRuns.get(id(99)),
    ],
  },
  {
    method: 'knowledgeReindexRuns.markRunning',
    name: 'running and started; others untouched',
    fixture,
    run: async (store) => {
      await store.knowledgeReindexRuns.markRunning(id(5));
      const read = await store.knowledgeReindexRuns.get(id(5));
      return [read?.status, read?.startedAt !== null, await statuses(store)];
    },
  },
  {
    method: 'knowledgeReindexRuns.failRun',
    name: 'failed with the error and finished; others untouched',
    fixture,
    run: async (store) => {
      await store.knowledgeReindexRuns.failRun(id(1), 'endpoint returned 502');
      const read = await store.knowledgeReindexRuns.get(id(1));
      return [read?.finishedAt !== null, await statuses(store)];
    },
  },
  {
    method: 'knowledgeReindexRuns.recordProgress',
    name: 'tallies added and cursor replaced; done finishes the run',
    fixture,
    run: async (store) => {
      await store.knowledgeReindexRuns.recordProgress(id(1), {
        processed: 10,
        skipped: 2,
        failed: 1,
        cursor: 'c-50',
        done: false,
      });
      const midway = await store.knowledgeReindexRuns.get(id(1));
      await store.knowledgeReindexRuns.recordProgress(id(2), {
        processed: 3,
        skipped: 0,
        failed: 0,
        cursor: null,
        done: true,
      });
      const finished = await store.knowledgeReindexRuns.get(id(2));
      return [midway, { ...finished, finishedAt: finished?.finishedAt !== null }];
    },
  },
];
