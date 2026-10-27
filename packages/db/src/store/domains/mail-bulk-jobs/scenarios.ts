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

const OLD = new Date(Date.UTC(2020, 0, 1));
const LATER = new Date(Date.UTC(2099, 0, 1));

function job(n: number, subject: string, extra: Record<string, unknown>) {
  return {
    id: id(n),
    subject,
    account_id: `acct-${subject}`,
    action: 'markRead',
    selection: JSON.stringify({ messageIds: ['m1'] }),
    created_at: OLD,
    updated_at: OLD,
    ...extra,
  };
}

/** Stalled, live and finished jobs, old and new, for the hourly sweep. */
const housekeeping = {
  mail_bulk_jobs: [
    job(31, 'ann', { status: 'running' }),
    job(32, 'ann', { status: 'running', updated_at: LATER }),
    job(33, 'bob', { status: 'succeeded', created_at: new Date(Date.UTC(2021, 0, 1)) }),
    job(34, 'bob', { status: 'partial' }),
    job(35, 'bob', { status: 'failed', created_at: LATER }),
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
  {
    method: 'mailBulkJobs.failStalled',
    name: 'silent running jobs fail with the reason; recent and other statuses untouched',
    fixture: housekeeping,
    run: async (store) => {
      const count = await store.mailBulkJobs.failStalled(60, 'job stalled');
      const jobs = [];
      for (const [n, subject] of [
        [31, 'ann'],
        [32, 'ann'],
        [33, 'bob'],
        [34, 'bob'],
      ] as const) {
        const job = await store.mailBulkJobs.getOwned(id(n), subject);
        jobs.push(
          job && {
            id: job.id,
            status: job.status,
            lastError: job.lastError,
            finished: !!job.finishedAt,
          }
        );
      }
      return { count, jobs };
    },
  },
  {
    method: 'mailBulkJobs.pruneFinished',
    name: 'old finished jobs go oldest first up to the limit; running and recent stay',
    fixture: housekeeping,
    run: async (store) => {
      const present = async () => {
        const out: string[] = [];
        for (const [n, subject] of [
          [31, 'ann'],
          [32, 'ann'],
          [33, 'bob'],
          [34, 'bob'],
          [35, 'bob'],
        ] as const) {
          if (await store.mailBulkJobs.getOwned(id(n), subject)) out.push(id(n));
        }
        return out;
      };
      const first = await store.mailBulkJobs.pruneFinished(30, 1);
      const afterFirst = await present();
      const rest = await store.mailBulkJobs.pruneFinished(30, 10);
      return { first, afterFirst, rest, afterAll: await present() };
    },
  },
];
