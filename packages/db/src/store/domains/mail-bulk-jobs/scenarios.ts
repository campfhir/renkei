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

type Job = Awaited<ReturnType<DataStore['mailBulkJobs']['get']>>;

/** started/finished are now() after a write: compare whether they are set. */
const jobView = (job: Job) =>
  job ? { ...job, startedAt: job.startedAt !== null, finishedAt: job.finishedAt !== null } : null;

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
  {
    method: 'mailBulkJobs.get',
    name: "anyone's job by id; unknown and malformed ids",
    fixture,
    run: async (store) => [
      await store.mailBulkJobs.get(id(1)),
      await store.mailBulkJobs.get(id(2)),
      await store.mailBulkJobs.get(id(9)),
      await store.mailBulkJobs.get('nope').then(
        () => 'accepted',
        (error: { code?: string }) => error.code
      ),
    ],
  },
  {
    method: 'mailBulkJobs.markRunning',
    name: 'running and started, that job only',
    fixture,
    run: async (store) => {
      await store.mailBulkJobs.markRunning(id(2));
      return [
        jobView(await store.mailBulkJobs.get(id(2))),
        jobView(await store.mailBulkJobs.get(id(1))),
      ];
    },
  },
  {
    method: 'mailBulkJobs.setTotal',
    name: 'total set, that job only',
    fixture,
    run: async (store) => {
      await store.mailBulkJobs.setTotal(id(2), 7);
      await store.mailBulkJobs.setTotal(id(9), 3);
      return [await store.mailBulkJobs.get(id(2)), await store.mailBulkJobs.get(id(1))];
    },
  },
  {
    method: 'mailBulkJobs.recordProgress',
    name: 'counts and failures replaced',
    fixture,
    run: async (store) => {
      await store.mailBulkJobs.recordProgress(id(1), {
        succeeded: 3,
        failed: 2,
        failures: [
          { id: 'm2', error: 'gone' },
          { id: 'm4', error: 'locked' },
        ],
      });
      await store.mailBulkJobs.recordProgress(id(2), { succeeded: 0, failed: 0, failures: [] });
      return [await store.mailBulkJobs.get(id(1)), await store.mailBulkJobs.get(id(2))];
    },
  },
  {
    method: 'mailBulkJobs.finish',
    name: 'status and finish time; the error only when given',
    fixture: {
      mail_bulk_jobs: [
        ...fixture.mail_bulk_jobs,
        {
          id: id(3),
          subject: 'ann',
          account_id: 'acct',
          action: 'move',
          selection: JSON.stringify({ messageIds: ['x'] }),
          status: 'running',
          last_error: 'earlier',
        },
      ],
    },
    run: async (store) => {
      await store.mailBulkJobs.finish(id(1), { status: 'partial', lastError: 'worker restarted' });
      await store.mailBulkJobs.finish(id(3), { status: 'succeeded' });
      return [
        jobView(await store.mailBulkJobs.get(id(1))),
        jobView(await store.mailBulkJobs.get(id(3))),
        jobView(await store.mailBulkJobs.get(id(2))),
      ];
    },
  },
];
