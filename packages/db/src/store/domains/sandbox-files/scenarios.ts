import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const BATCH = '00000000-0000-4000-8000-0000000000b1';

function row(
  n: number,
  subject: string,
  minute: number,
  size: number,
  batch: string | null = null
) {
  return {
    id: id(n),
    subject,
    filename: `file-${n}.txt`,
    content_type: n % 2 ? 'text/plain' : null,
    size_bytes: size,
    storage_key: `key-${n}`,
    source: 'upload',
    batch_id: batch,
    created_at: at(minute),
    expires_at: at(100 + n),
  };
}

const fixture = {
  sandbox_files: [
    row(1, 'ann', 1, 10),
    row(2, 'ann', 3, 20, BATCH),
    row(3, 'ann', 3, 30),
    row(4, 'ann', 2, 40, BATCH),
    row(5, 'bob', 5, 50, BATCH),
  ],
};

export const sandboxFileScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxFiles.insert',
    name: 'records a file, read back by the subject only',
    fixture,
    run: async (store) => {
      const inserted = await store.sandboxFiles.insert({
        id: id(9),
        subject: 'ann',
        filename: 'new.csv',
        contentType: 'text/csv',
        sizeBytes: 7,
        storageKey: 'key-9',
        source: 'browser',
        batchId: null,
        expiresAt: at(500),
      });
      const { createdAt: _createdAt, ...rest } = inserted;
      const listed = await store.sandboxFiles.list('ann');
      return [
        rest,
        listed.map((file) => file.id),
        await store.sandboxFiles.get('bob', id(9)),
        (await store.sandboxFiles.get('ann', id(9)))?.filename,
      ];
    },
  },
  {
    method: 'sandboxFiles.list',
    name: 'newest first, ties by id, optionally one batch',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.list('ann'),
      await store.sandboxFiles.list('ann', BATCH),
      await store.sandboxFiles.list('nobody'),
    ],
  },
  {
    method: 'sandboxFiles.countForSubject',
    name: 'per subject',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.countForSubject('ann'),
      await store.sandboxFiles.countForSubject('bob'),
      await store.sandboxFiles.countForSubject('nobody'),
    ],
  },
  {
    method: 'sandboxFiles.totalBytesForSubject',
    name: 'summed per subject, zero with none',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.totalBytesForSubject('ann'),
      await store.sandboxFiles.totalBytesForSubject('bob'),
      await store.sandboxFiles.totalBytesForSubject('nobody'),
    ],
  },
  {
    method: 'sandboxFiles.countForBatch',
    name: 'across subjects',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.countForBatch(BATCH),
      await store.sandboxFiles.countForBatch(id(77)),
    ],
  },
  {
    method: 'sandboxFiles.totalBytesForBatch',
    name: 'across subjects, zero with none',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.totalBytesForBatch(BATCH),
      await store.sandboxFiles.totalBytesForBatch(id(77)),
    ],
  },
  {
    method: 'sandboxFiles.get',
    name: 'the subject’s own file only',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.get('ann', id(1)),
      await store.sandboxFiles.get('bob', id(1)),
      await store.sandboxFiles.get('ann', id(99)),
    ],
  },
  {
    method: 'sandboxFiles.delete',
    name: 'returns the row, leaves other subjects’ alone',
    fixture,
    run: async (store) => [
      await store.sandboxFiles.delete('bob', id(1)),
      await store.sandboxFiles.delete('ann', id(1)),
      await store.sandboxFiles.delete('ann', id(1)),
      (await store.sandboxFiles.list('ann')).map((file) => file.id),
    ],
  },
  {
    method: 'sandboxFiles.listExpired',
    name: 'soonest expiring first, bounded',
    fixture,
    run: async (store) => [
      (await store.sandboxFiles.listExpired(at(104), 10)).map((file) => file.id),
      (await store.sandboxFiles.listExpired(at(200), 2)).map((file) => file.id),
      await store.sandboxFiles.listExpired(at(0), 10),
    ],
  },
  {
    method: 'sandboxFiles.deleteById',
    name: 'whoever holds it',
    fixture,
    run: async (store) => {
      await store.sandboxFiles.deleteById(id(5));
      await store.sandboxFiles.deleteById(id(99));
      return [
        await store.sandboxFiles.list('bob'),
        await store.sandboxFiles.countForSubject('ann'),
      ];
    },
  },
];
