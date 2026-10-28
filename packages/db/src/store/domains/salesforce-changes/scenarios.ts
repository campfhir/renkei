import type { Scenario } from '../../domain';
import type { NewRow } from '../../memory/tables';
import type { DataStore } from '../../types';
import type { SalesforceChangeRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-5f${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2020-01-01T00:00:00.000Z');

function row(
  n: number,
  subject: string,
  minute: number,
  extra: Partial<NewRow<'salesforce_admin_change_requests'>> = {}
): NewRow<'salesforce_admin_change_requests'> {
  return {
    id: id(n),
    subject,
    connector_key: n % 2 ? 'uat' : 'prod',
    org_id: '00D000000000062EAA',
    instance_url: 'https://acme--uat.sandbox.my.salesforce.com',
    kind: 'fields',
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
  salesforce_admin_change_requests: [
    row(1, 'ann', 1, { validation: { deployId: '0Af1', done: true } }),
    row(2, 'ann', 3),
    row(3, 'ann', 2, { expires_at: PAST }),
    row(4, 'ann', 3, { status: 'applied', results: { operations: [] } }),
    row(5, 'bob', 5, { kind: 'request', agent_id: id(90) }),
    row(6, 'bob', 4, { status: 'queued', approved_by: 'op', step: 'Waiting to start' }),
    row(7, 'bob', 6, { status: 'applying', step: 'Deploying' }),
    row(8, 'cat', 0, { status: 'queued' }),
  ],
};

/** A record without the times "now" stamped, which the two stores' clocks cannot agree on. */
function settled(change: SalesforceChangeRecord | null) {
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

export const salesforceChangeScenarios: Scenario<DataStore>[] = [
  {
    method: 'salesforceChanges.create',
    name: 'pending, expiring ttl hours after it was made, JSON kept',
    run: async (store) => {
      const made = await store.salesforceChanges.create({
        subject: 'ann',
        agentId: null,
        connectorKey: 'uat',
        orgId: '00D000000000062EAA',
        instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
        kind: 'fields',
        title: 'Site Visit: add Outcome',
        reason: 'outcomes',
        payload: { files: { 'package.xml': '<Package/>' }, list: [1, 'two'] },
        ttlHours: 24,
      });
      const read = await store.salesforceChanges.get(made.id);
      const { id: _id, createdAt, updatedAt, expiresAt, ...rest } = made;
      return {
        rest,
        hours: (expiresAt.getTime() - createdAt.getTime()) / 3_600_000,
        sameTimes: createdAt.getTime() === updatedAt.getTime(),
        readBack: read?.title,
        listed: (await store.salesforceChanges.list({ limit: 5, subject: 'ann' })).length,
      };
    },
  },
  {
    method: 'salesforceChanges.get',
    name: 'by id, scoped to a subject when given',
    fixture,
    run: async (store) => [
      await store.salesforceChanges.get(id(1)),
      await store.salesforceChanges.get(id(1), { subject: 'ann' }),
      await store.salesforceChanges.get(id(1), { subject: 'bob' }),
      await store.salesforceChanges.get(id(99)),
    ],
  },
  {
    method: 'salesforceChanges.list',
    name: 'newest first, ties by id, bounded and filtered',
    fixture,
    run: async (store) => {
      const ids = (rows: SalesforceChangeRecord[]) => rows.map((r) => r.id);
      return [
        await store.salesforceChanges.list({ limit: 100 }),
        ids(await store.salesforceChanges.list({ limit: 3 })),
        ids(await store.salesforceChanges.list({ limit: 50, subject: 'ann' })),
        ids(await store.salesforceChanges.list({ limit: 50, subject: 'ann', pendingOnly: true })),
        ids(await store.salesforceChanges.list({ limit: 50, subject: 'ann', connectorKey: 'uat' })),
        ids(await store.salesforceChanges.list({ limit: 50, subject: 'nobody' })),
      ];
    },
  },
  {
    method: 'salesforceChanges.countPendingByConnector',
    name: 'pending and unexpired, per connector, by key; everyone or one person',
    fixture,
    run: async (store) => [
      await store.salesforceChanges.countPendingByConnector(),
      await store.salesforceChanges.countPendingByConnector({ subject: 'ann' }),
      await store.salesforceChanges.countPendingByConnector({ subject: 'nobody' }),
    ],
  },
  {
    method: 'salesforceChanges.setValidation',
    name: 'replaces the validation',
    fixture,
    run: async (store) => {
      await store.salesforceChanges.setValidation(id(2), { error: 'nope', checkedAt: 'x' });
      return [
        settled(await store.salesforceChanges.get(id(2))),
        (await store.salesforceChanges.get(id(1)))?.validation,
      ];
    },
  },
  {
    method: 'salesforceChanges.claim',
    name: 'only the owner, only pending and unexpired, only once',
    fixture,
    run: async (store) => {
      const wins = [
        await store.salesforceChanges.claim('bob', id(2)),
        await store.salesforceChanges.claim('ann', id(3)),
        await store.salesforceChanges.claim('ann', id(2)),
        await store.salesforceChanges.claim('ann', id(2)),
        await store.salesforceChanges.claim('ann', id(4)),
      ];
      return { wins, after: settled(await store.salesforceChanges.get(id(2))) };
    },
  },
  {
    method: 'salesforceChanges.recordDeployStarted',
    name: 'only on an applying request',
    fixture,
    run: async (store) => {
      await store.salesforceChanges.recordDeployStarted(id(7), {
        deployId: '0Af7',
        operations: [],
      });
      await store.salesforceChanges.recordDeployStarted(id(2), {
        deployId: '0Af2',
        operations: [],
      });
      return [
        settled(await store.salesforceChanges.get(id(7))),
        settled(await store.salesforceChanges.get(id(2))),
      ];
    },
  },
  {
    method: 'salesforceChanges.finish',
    name: 'ends an applying request once, clearing the step',
    fixture,
    run: async (store) => {
      const outcome = {
        status: 'applied' as const,
        results: { operations: [{ label: 'Deploy', outcome: 'done' }] },
        appliedBy: 'op',
      };
      const wins = [
        await store.salesforceChanges.finish(id(7), outcome),
        await store.salesforceChanges.finish(id(7), { ...outcome, status: 'failed' }),
        await store.salesforceChanges.finish(id(2), outcome),
      ];
      return { wins, after: settled(await store.salesforceChanges.get(id(7))) };
    },
  },
  {
    method: 'salesforceChanges.cancel',
    name: 'pending only; scoped to the subject unless none is given; with or without a note',
    fixture,
    run: async (store) => {
      const wins = [
        await store.salesforceChanges.cancel(id(2), { subject: 'bob' }),
        await store.salesforceChanges.cancel(id(2), { subject: 'ann' }),
        await store.salesforceChanges.cancel(id(5), { resolution: 'Not now' }),
        await store.salesforceChanges.cancel(id(3), { subject: 'ann' }),
        await store.salesforceChanges.cancel(id(4), {}),
      ];
      return {
        wins,
        rows: [
          settled(await store.salesforceChanges.get(id(2))),
          settled(await store.salesforceChanges.get(id(5))),
          (await store.salesforceChanges.get(id(3)))?.status,
        ],
      };
    },
  },
  {
    method: 'salesforceChanges.queue',
    name: 'pending, unexpired, not of the excepted kind; once',
    fixture,
    run: async (store) => {
      const options = { approvedBy: 'op', step: 'Waiting to start', exceptKind: 'request' };
      const wins = [
        await store.salesforceChanges.queue(id(5), options),
        await store.salesforceChanges.queue(id(3), options),
        await store.salesforceChanges.queue(id(2), options),
        await store.salesforceChanges.queue(id(2), options),
      ];
      return { wins, after: settled(await store.salesforceChanges.get(id(2))) };
    },
  },
  {
    method: 'salesforceChanges.startQueued',
    name: 'queued only, once',
    fixture,
    run: async (store) => {
      const wins = [
        await store.salesforceChanges.startQueued(id(6), 'Starting'),
        await store.salesforceChanges.startQueued(id(6), 'Starting'),
        await store.salesforceChanges.startQueued(id(2), 'Starting'),
      ];
      return { wins, after: settled(await store.salesforceChanges.get(id(6))) };
    },
  },
  {
    method: 'salesforceChanges.reclaimStale',
    name: 'an applying request untouched for longer than the bound, once',
    fixture,
    run: async (store) => {
      const tenYears = 10 * 365 * 24 * 3_600_000;
      const wins = [
        await store.salesforceChanges.reclaimStale(id(7), tenYears),
        await store.salesforceChanges.reclaimStale(id(7), 90_000),
        await store.salesforceChanges.reclaimStale(id(7), 90_000),
        await store.salesforceChanges.reclaimStale(id(6), 90_000),
      ];
      return { wins, after: settled(await store.salesforceChanges.get(id(7))) };
    },
  },
  {
    method: 'salesforceChanges.setStep',
    name: 'queued or applying only',
    fixture,
    run: async (store) => {
      const wins = [
        await store.salesforceChanges.setStep(id(6), 'Halfway'),
        await store.salesforceChanges.setStep(id(7), 'Nearly'),
        await store.salesforceChanges.setStep(id(2), 'Never'),
      ];
      return {
        wins,
        steps: [
          (await store.salesforceChanges.get(id(6)))?.step,
          (await store.salesforceChanges.get(id(7)))?.step,
          (await store.salesforceChanges.get(id(2)))?.step,
        ],
      };
    },
  },
  {
    method: 'salesforceChanges.listRunnable',
    name: 'queued and stale applying, least recently touched first, bounded',
    fixture,
    run: async (store) => [
      await store.salesforceChanges.listRunnable(90_000, 5),
      await store.salesforceChanges.listRunnable(90_000, 2),
      await store.salesforceChanges.listRunnable(10 * 365 * 24 * 3_600_000, 5),
    ],
  },
  {
    method: 'salesforceChanges.closeAsProposed',
    name: 'a pending request of the kind, once, with the resolution',
    fixture,
    run: async (store) => {
      const options = { kind: 'request', resolution: `Built as ${id(2)}.` };
      const wins = [
        await store.salesforceChanges.closeAsProposed(id(2), options),
        await store.salesforceChanges.closeAsProposed(id(5), options),
        await store.salesforceChanges.closeAsProposed(id(5), options),
      ];
      return { wins, after: settled(await store.salesforceChanges.get(id(5))) };
    },
  },
];
