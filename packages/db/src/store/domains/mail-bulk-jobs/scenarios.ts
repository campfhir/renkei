import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const fixture = {
  mail_bulk_jobs: [
    {
      id: id(1),
      subject: 'ann',
      account_id: 'acct',
      action: 'markRead',
      params: JSON.stringify({ isRead: true }),
      selection: JSON.stringify({ messageIds: ['m1', 'm2'] }),
      status: 'running',
      total: 2,
      succeeded: 1,
      failed: 1,
      failures: JSON.stringify([{ id: 'm2', error: 'gone' }]),
      started_at: at(1),
    },
    {
      id: id(2),
      subject: 'bob',
      account_id: 'acct-b',
      action: 'flag',
      selection: JSON.stringify({ filters: {} }),
    },
  ],
};

export const mailBulkJobScenarios: Scenario<DataStore>[] = [
  {
    method: 'mailBulkJobs.getOwned',
    name: 'own job only; unknown and malformed ids',
    fixture,
    run: async (store) => [
      await store.mailBulkJobs.getOwned(id(1), 'ann'),
      await store.mailBulkJobs.getOwned(id(2), 'ann'),
      await store.mailBulkJobs.getOwned(id(2), 'bob'),
      await store.mailBulkJobs.getOwned('nope', 'ann').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      ),
    ],
  },
  {
    method: 'mailBulkJobs.create',
    name: 'queued with defaults after; a reused id is refused',
    fixture,
    run: async (store) => {
      const job = {
        id: id(3),
        subject: 'ann',
        accountId: 'acct',
        action: 'move',
        params: { destinationFolder: 'archive' },
        selection: { messageIds: ['x'] },
      };
      await store.mailBulkJobs.create(job);
      const again = await store.mailBulkJobs.create(job).then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      );
      return { again, read: await store.mailBulkJobs.getOwned(id(3), 'ann') };
    },
  },
  {
    method: 'mailBulkJobs.markFailed',
    name: 'that job only',
    fixture,
    run: async (store) => {
      await store.mailBulkJobs.markFailed(id(2), 'could not enqueue the job');
      await store.mailBulkJobs.markFailed(id(9), 'nothing');
      return [
        await store.mailBulkJobs.getOwned(id(2), 'bob'),
        (await store.mailBulkJobs.getOwned(id(1), 'ann'))?.status ?? null,
      ];
    },
  },
];
