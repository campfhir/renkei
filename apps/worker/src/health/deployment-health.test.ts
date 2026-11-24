/**
 * The sweep that notices an application gone quiet: it reads every
 * environment that has checked in, and queues a change once per state the
 * clock moves it into.
 */

const enqueue = jest.fn(async (_message: unknown) => ({ ok: true as const, val: 'id' }));
jest.mock('../queue', () => ({ eventsQueue: { producer: { enqueue } } }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { asRecord } from '@renkei/guards';
import { createDeploymentHealthSweep } from './deployment-health';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const AT = Date.parse('2026-11-24T10:00:00Z');
const MINUTE = 60_000;

/** An environment whose application checked in at AT, due again in a minute. */
async function checkedIn(status: string, environment = 'production'): Promise<void> {
  const store = getDataStore().ciHealth;
  const hash = `hash-${environment}`;
  await store.issueToken(PROJECT, environment, {
    hash,
    hint: 'abcd',
    issuedBy: 'auth0|owner',
    at: new Date(AT - MINUTE),
  });
  await store.checkIn(hash, {
    status,
    message: 'queue depth 3',
    version: '1.4.2',
    sentAt: new Date(AT),
    receivedAt: new Date(AT),
    intervalSeconds: 60,
  });
  // What the check-in itself announced (the web app does this as it arrives).
  await store.announce(PROJECT, environment, null, status);
}

const sweepAt = (ms: number) => createDeploymentHealthSweep(() => new Date(AT + ms))();
const queued = () =>
  enqueue.mock.calls.map(([message]) => {
    const payload = asRecord(asRecord(message).payload);
    return {
      type: asRecord(message).type,
      state: payload.state,
      previous: payload.previous,
      missed: payload.missed,
    };
  });

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  enqueue.mockClear();
});
afterEach(() => resetDataStore());

it('says nothing while check-ins arrive on time', async () => {
  await checkedIn('healthy');
  await sweepAt(MINUTE);
  expect(queued()).toEqual([]);
});

it('queues potentially failing once a check-in is overdue, and only once', async () => {
  await checkedIn('healthy');
  await sweepAt(2 * MINUTE);
  await sweepAt(2 * MINUTE + 10_000);
  expect(queued()).toEqual([
    { type: 'health.changed', state: 'late', previous: 'healthy', missed: 1 },
  ]);
});

it('then failed, when three in a row were missed', async () => {
  await checkedIn('healthy');
  await sweepAt(2 * MINUTE);
  await sweepAt(4 * MINUTE);
  expect(queued().map((change) => [change.previous, change.state])).toEqual([
    ['healthy', 'late'],
    ['late', 'failed'],
  ]);
});

it('queues stopped for one that said it was stopping and went quiet', async () => {
  await checkedIn('stopping');
  await sweepAt(5 * MINUTE);
  expect(queued().map((change) => change.state)).toEqual(['stopped']);
});

it('carries what the application last said, and names the environment on the queue', async () => {
  await checkedIn('healthy', 'staging');
  await sweepAt(2 * MINUTE);
  expect(enqueue).toHaveBeenCalledWith({
    source: 'deployments',
    type: 'health.changed',
    orderingKey: `deployments/${PROJECT}/staging`,
    payload: {
      kind: 'health',
      projectId: PROJECT,
      environment: 'staging',
      state: 'late',
      previous: 'healthy',
      missed: 1,
      message: 'queue depth 3',
      version: '1.4.2',
      at: new Date(AT + 2 * MINUTE).toISOString(),
    },
  });
});

it('leaves an environment that never checked in alone', async () => {
  await getDataStore().ciHealth.issueToken(PROJECT, 'production', {
    hash: 'h',
    hint: 'abcd',
    issuedBy: 'auth0|owner',
    at: new Date(AT),
  });
  await sweepAt(24 * 60 * MINUTE);
  expect(queued()).toEqual([]);
});
