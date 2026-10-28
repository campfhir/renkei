import type { Scenario } from '../../domain';
import type { NewRow } from '../../memory/tables';
import type { DataStore } from '../../types';
import type { JiraChangeRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-3a${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2020-01-01T00:00:00.000Z');

function row(
  n: number,
  subject: string,
  minute: number,
  extra: Partial<NewRow<'jira_admin_change_requests'>> = {}
): NewRow<'jira_admin_change_requests'> {
  return {
    id: id(n),
    subject,
    cloud_id: 'cloud-1',
    site_url: n % 2 ? 'https://acme.atlassian.net' : null,
    kind: 'field_options',
    title: `change ${n}`,
    payload: { n, files: { 'package.xml': '<Package/>' } },
    status: 'pending',
    expires_at: FUTURE,
    created_at: at(minute),
    updated_at: at(minute),
    ...extra,
  };
}

const fixture = {
  jira_admin_change_requests: [
    row(1, 'ann', 1, { reason: 'because' }),
    row(2, 'ann', 3),
    row(3, 'ann', 2, { expires_at: PAST }),
    row(4, 'ann', 3, {
      status: 'applied',
      results: [{ label: 'Add', outcome: 'done' }],
    }),
    row(5, 'bob', 5, { kind: 'request', agent_id: id(90) }),
    row(6, 'bob', 4, { status: 'queued', approved_by: 'op', step: 'Waiting to start' }),
    row(7, 'bob', 6, { status: 'applying', step: 'Deploying' }),
    row(8, 'cat', 0, { status: 'queued' }),
  ],
};

/** A record without the times "now" stamped, which the two stores' clocks cannot agree on. */
function settled(change: JiraChangeRecord | null) {
  if (!change) return null;
  const { updatedAt, appliedAt, cancelledAt, approvedAt, ...rest } = change;
  return {
    ...rest,
    touched: updatedAt.getTime() > at(59).getTime(),
    applied: appliedAt !== null,
    cancelled: cancelledAt !== null,
    approved: approvedAt !== null,
  };
}

export const jiraChangeScenarios: Scenario<DataStore>[] = [
  {
    method: 'jiraChanges.create',
    name: 'pending, expiring ttl hours after it was made, JSON kept',
    run: async (store) => {
      const made = await store.jiraChanges.create({
        subject: 'ann',
        agentId: null,
        cloudId: 'cloud-1',
        siteUrl: null,
        kind: 'field_options',
        title: 'Site Visit: add Outcome',
        reason: 'outcomes',
        payload: { files: { 'package.xml': '<Package/>' }, list: [1, 'two'] },
        ttlHours: 24,
      });
      const read = await store.jiraChanges.get(made.id);
      const { id: _id, createdAt, updatedAt, expiresAt, ...rest } = made;
      return {
        rest,
        hours: (expiresAt.getTime() - createdAt.getTime()) / 3_600_000,
        sameTimes: createdAt.getTime() === updatedAt.getTime(),
        readBack: read?.title,
        listed: (await store.jiraChanges.list({ limit: 5, subject: 'ann' })).length,
      };
    },
  },
  {
    method: 'jiraChanges.get',
    name: 'by id, scoped to a subject when given',
    fixture,
    run: async (store) => [
      await store.jiraChanges.get(id(1)),
      await store.jiraChanges.get(id(1), { subject: 'ann' }),
      await store.jiraChanges.get(id(1), { subject: 'bob' }),
      await store.jiraChanges.get(id(99)),
    ],
  },
  {
    method: 'jiraChanges.list',
    name: 'newest first, ties by id, bounded and filtered',
    fixture,
    run: async (store) => {
      const ids = (rows: JiraChangeRecord[]) => rows.map((r) => r.id);
      return [
        await store.jiraChanges.list({ limit: 100 }),
        ids(await store.jiraChanges.list({ limit: 3 })),
        ids(await store.jiraChanges.list({ limit: 50, subject: 'ann' })),
        ids(await store.jiraChanges.list({ limit: 50, subject: 'ann', pendingOnly: true })),
        ids(await store.jiraChanges.list({ limit: 50, subject: 'nobody' })),
      ];
    },
  },
  {
    method: 'jiraChanges.countPending',
    name: 'pending and unexpired; everyone or one person',
    fixture,
    run: async (store) => [
      await store.jiraChanges.countPending(),
      await store.jiraChanges.countPending({ subject: 'ann' }),
      await store.jiraChanges.countPending({ subject: 'nobody' }),
    ],
  },
  {
    method: 'jiraChanges.claim',
    name: 'only the owner, only pending and unexpired, only once',
    fixture,
    run: async (store) => {
      const wins = [
        await store.jiraChanges.claim('bob', id(2)),
        await store.jiraChanges.claim('ann', id(3)),
        await store.jiraChanges.claim('ann', id(2)),
        await store.jiraChanges.claim('ann', id(2)),
        await store.jiraChanges.claim('ann', id(4)),
      ];
      return { wins, after: settled(await store.jiraChanges.get(id(2))) };
    },
  },
  {
    method: 'jiraChanges.finish',
    name: 'ends an applying request once, clearing the step',
    fixture,
    run: async (store) => {
      const outcome = {
        status: 'applied' as const,
        results: [{ label: 'Add', outcome: 'done' }],
        appliedBy: 'op',
      };
      const wins = [
        await store.jiraChanges.finish(id(7), outcome),
        await store.jiraChanges.finish(id(7), { ...outcome, status: 'failed' }),
        await store.jiraChanges.finish(id(2), outcome),
      ];
      return { wins, after: settled(await store.jiraChanges.get(id(7))) };
    },
  },
  {
    method: 'jiraChanges.cancel',
    name: 'pending only; scoped to the subject unless none is given; with or without a note',
    fixture,
    run: async (store) => {
      const wins = [
        await store.jiraChanges.cancel(id(2), { subject: 'bob' }),
        await store.jiraChanges.cancel(id(2), { subject: 'ann' }),
        await store.jiraChanges.cancel(id(5), { resolution: 'Not now' }),
        await store.jiraChanges.cancel(id(3), { subject: 'ann' }),
        await store.jiraChanges.cancel(id(4), {}),
      ];
      return {
        wins,
        rows: [
          settled(await store.jiraChanges.get(id(2))),
          settled(await store.jiraChanges.get(id(5))),
          (await store.jiraChanges.get(id(3)))?.status,
        ],
      };
    },
  },
  {
    method: 'jiraChanges.queue',
    name: 'pending, unexpired, not of the excepted kind; once',
    fixture,
    run: async (store) => {
      const options = { approvedBy: 'op', step: 'Waiting to start', exceptKind: 'request' };
      const wins = [
        await store.jiraChanges.queue(id(5), options),
        await store.jiraChanges.queue(id(3), options),
        await store.jiraChanges.queue(id(2), options),
        await store.jiraChanges.queue(id(2), options),
      ];
      return { wins, after: settled(await store.jiraChanges.get(id(2))) };
    },
  },
  {
    method: 'jiraChanges.startQueued',
    name: 'queued only, once',
    fixture,
    run: async (store) => {
      const wins = [
        await store.jiraChanges.startQueued(id(6), 'Starting'),
        await store.jiraChanges.startQueued(id(6), 'Starting'),
        await store.jiraChanges.startQueued(id(2), 'Starting'),
      ];
      return { wins, after: settled(await store.jiraChanges.get(id(6))) };
    },
  },
  {
    method: 'jiraChanges.reclaimStale',
    name: 'an applying request untouched for longer than the bound, once',
    fixture,
    run: async (store) => {
      const tenYears = 10 * 365 * 24 * 3_600_000;
      const wins = [
        await store.jiraChanges.reclaimStale(id(7), tenYears),
        await store.jiraChanges.reclaimStale(id(7), 90_000),
        await store.jiraChanges.reclaimStale(id(7), 90_000),
        await store.jiraChanges.reclaimStale(id(6), 90_000),
      ];
      return { wins, after: settled(await store.jiraChanges.get(id(7))) };
    },
  },
  {
    method: 'jiraChanges.setStep',
    name: 'queued or applying only',
    fixture,
    run: async (store) => {
      const wins = [
        await store.jiraChanges.setStep(id(6), 'Halfway'),
        await store.jiraChanges.setStep(id(7), 'Nearly'),
        await store.jiraChanges.setStep(id(2), 'Never'),
      ];
      return {
        wins,
        steps: [
          (await store.jiraChanges.get(id(6)))?.step,
          (await store.jiraChanges.get(id(7)))?.step,
          (await store.jiraChanges.get(id(2)))?.step,
        ],
      };
    },
  },
  {
    method: 'jiraChanges.listRunnable',
    name: 'queued and stale applying, least recently touched first, bounded',
    fixture,
    run: async (store) => [
      await store.jiraChanges.listRunnable(90_000, 5),
      await store.jiraChanges.listRunnable(90_000, 2),
      await store.jiraChanges.listRunnable(10 * 365 * 24 * 3_600_000, 5),
    ],
  },
  {
    method: 'jiraChanges.closeAsProposed',
    name: 'a pending request of the kind, once, with the resolution',
    fixture,
    run: async (store) => {
      const options = { kind: 'request', resolution: `Built as ${id(2)}.` };
      const wins = [
        await store.jiraChanges.closeAsProposed(id(2), options),
        await store.jiraChanges.closeAsProposed(id(5), options),
        await store.jiraChanges.closeAsProposed(id(5), options),
      ];
      return { wins, after: settled(await store.jiraChanges.get(id(5))) };
    },
  },
];
