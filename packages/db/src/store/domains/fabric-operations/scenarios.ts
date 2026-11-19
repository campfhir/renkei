import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-17${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const definition = {
  format: 'ipynb',
  parts: [{ path: 'notebook-content.ipynb', text: '{"cells":[]}' }],
};

const row = (n: number, fields: Record<string, unknown>) => ({
  id: id(n),
  subject: 'ann',
  kind: 'notebook-definition',
  workspace_id: 'ws-1',
  workspace_name: 'Sales',
  item_id: `item-${n}`,
  item_name: `Notebook ${n}`,
  format: 'ipynb',
  status: 'running',
  operation_id: `op-${n}`,
  percent_complete: null,
  result: null,
  error: null,
  next_poll_at: at(10),
  watched_at: null,
  notified_at: null,
  created_at: at(n),
  updated_at: at(n),
  finished_at: null,
  ...fields,
});

const fixture = {
  fabric_operations: [
    row(1, {}),
    row(2, { next_poll_at: at(30) }),
    row(3, { watched_at: at(9) }),
    row(4, {
      status: 'succeeded',
      result: definition,
      percent_complete: 100,
      next_poll_at: null,
      finished_at: at(5),
    }),
    row(5, { subject: 'bob', kind: 'pipeline-definition', format: null, next_poll_at: null }),
    row(6, { status: 'failed', error: 'Forbidden', next_poll_at: null, finished_at: at(20) }),
  ],
};

export const fabricOperationScenarios: Scenario<DataStore>[] = [
  {
    method: 'fabricOperations.insert',
    name: 'reads back as stored, result included',
    fixture,
    run: async (store) => [
      await store.fabricOperations.insert({
        id: id(9),
        subject: 'cy',
        kind: 'pipeline-definition',
        workspaceId: 'ws-2',
        workspaceName: 'Ops',
        itemId: 'pipe-1',
        itemName: 'Nightly load',
        format: null,
        status: 'succeeded',
        operationId: null,
        percentComplete: 100,
        result: { format: null, parts: [{ path: 'pipeline-content.json', text: '{}' }] },
        error: null,
        nextPollAt: null,
        finishedAt: at(40),
        createdAt: at(40),
      }),
      await store.fabricOperations.find('cy', id(9)),
    ],
  },
  {
    method: 'fabricOperations.find',
    name: "the owner's only; another person's or unknown is null",
    fixture,
    run: async (store) => [
      await store.fabricOperations.find('ann', id(4)),
      await store.fabricOperations.find('bob', id(4)),
      await store.fabricOperations.find('ann', id(99)),
    ],
  },
  {
    method: 'fabricOperations.list',
    name: 'newest first, limited, one person',
    fixture,
    run: async (store) => [
      (await store.fabricOperations.list('ann', { limit: 3 })).map((op) => op.id),
      (await store.fabricOperations.list('bob', { limit: 10 })).map((op) => op.id),
    ],
  },
  {
    method: 'fabricOperations.claim',
    name: 'due and running only; a second claim inside the lease is refused',
    fixture,
    run: async (store) => [
      await store.fabricOperations.claim(id(1), at(10), at(12)),
      await store.fabricOperations.claim(id(1), at(11), at(13)),
      await store.fabricOperations.claim(id(2), at(10), at(12)),
      await store.fabricOperations.claim(id(4), at(50), at(52)),
      await store.fabricOperations.claim(id(5), at(0), at(2)),
    ],
  },
  {
    method: 'fabricOperations.claimDue',
    name: 'due, running, unwatched; null next poll first; leased',
    fixture,
    run: async (store) => [
      (
        await store.fabricOperations.claimDue({
          now: at(15),
          leaseUntil: at(17),
          unwatchedSince: at(8),
          limit: 10,
        })
      ).map((op) => [op.id, op.nextPollAt]),
      (
        await store.fabricOperations.claimDue({
          now: at(15),
          leaseUntil: at(17),
          unwatchedSince: at(10),
          limit: 1,
        })
      ).map((op) => op.id),
    ],
  },
  {
    method: 'fabricOperations.progress',
    name: 'running only',
    fixture,
    run: async (store) => [
      await store.fabricOperations.progress(
        id(1),
        { percentComplete: 40, nextPollAt: at(20), operationId: 'op-new' },
        at(15)
      ),
      await store.fabricOperations.progress(
        id(4),
        { percentComplete: 40, nextPollAt: at(20) },
        at(15)
      ),
    ],
  },
  {
    method: 'fabricOperations.finish',
    name: 'only the first finisher gets the row',
    fixture,
    run: async (store) => [
      await store.fabricOperations.finish(
        id(1),
        { status: 'succeeded', result: definition, error: null },
        at(25)
      ),
      await store.fabricOperations.finish(
        id(1),
        { status: 'failed', result: null, error: 'late' },
        at(26)
      ),
      await store.fabricOperations.finish(
        id(2),
        { status: 'failed', result: null, error: 'Forbidden' },
        at(27)
      ),
    ],
  },
  {
    method: 'fabricOperations.markWatched',
    name: "the owner's row only",
    fixture,
    run: async (store) => {
      await store.fabricOperations.markWatched('ann', id(1), at(33));
      await store.fabricOperations.markWatched('bob', id(2), at(34));
      return [
        (await store.fabricOperations.find('ann', id(1)))?.watchedAt,
        (await store.fabricOperations.find('ann', id(2)))?.watchedAt,
      ];
    },
  },
  {
    method: 'fabricOperations.markNotified',
    name: 'true once',
    fixture,
    run: async (store) => [
      await store.fabricOperations.markNotified(id(4), at(40)),
      await store.fabricOperations.markNotified(id(4), at(41)),
      (await store.fabricOperations.find('ann', id(4)))?.notifiedAt,
    ],
  },
  {
    method: 'fabricOperations.deleteFinishedBefore',
    name: 'finished strictly before the cut; running rows stay',
    fixture,
    run: async (store) => [
      await store.fabricOperations.deleteFinishedBefore(at(20)),
      (await store.fabricOperations.list('ann', { limit: 10 })).map((op) => op.id),
    ],
  },
];
