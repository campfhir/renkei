/**
 * Raising a change, on the memory store: an application's check-in that
 * says something new is queued once, for the worker to tell people and
 * wake agents; the same status again is not; and a change that cannot be
 * queued never costs the check-in.
 */

const enqueue = jest.fn();
jest.mock('@renkei/queue', () => ({
  webhookEventsQueue: () => ({ producer: { enqueue } }),
}));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { asRecord } from '@renkei/guards';
import { raiseChange, settleHealth } from './deployment-changes';
import { issueHealthToken, recordCheckIn } from './health';

const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const AT = Date.parse('2026-11-24T10:00:00Z');
const MINUTE = 60_000;

let token: string;
const send = (status: string, at: number, extra: Record<string, unknown> = {}) =>
  recordCheckIn({
    authorization: `Bearer ${token}`,
    body: { status, nextCheckInSeconds: 60, ...extra },
    now: new Date(at),
  });
const queued = () =>
  enqueue.mock.calls.map(([message]) => {
    const payload = asRecord(asRecord(message).payload);
    return [payload.previous, payload.state];
  });
const record = async () => {
  const [found] = await getDataStore().ciHealth.listForProject(PROJECT);
  if (!found) throw new Error('no check-ins row');
  return found;
};

beforeEach(async () => {
  registerDataStore(createMemoryDataStore());
  enqueue.mockReset();
  enqueue.mockResolvedValue({ ok: true, val: 'id' });
  token = (await issueHealthToken(PROJECT, 'production', 'auth0|ada', new Date(AT - MINUTE))).token;
});
afterEach(() => resetDataStore());

describe('a check-in', () => {
  it('is a change the first time, and when it says something else', async () => {
    await send('starting', AT);
    await send('healthy', AT + MINUTE);
    await send('error', AT + 2 * MINUTE, { message: 'database unreachable' });
    expect(queued()).toEqual([
      [null, 'starting'],
      ['starting', 'healthy'],
      ['healthy', 'error'],
    ]);
  });

  it('is not one when it says the same again', async () => {
    await send('healthy', AT);
    await send('healthy', AT + MINUTE);
    await send('healthy', AT + 2 * MINUTE);
    expect(queued()).toEqual([[null, 'healthy']]);
  });

  it('rides the queue as a health change of its environment, with what it said and no token', async () => {
    await send('degraded', AT, { message: 'queue depth 40', version: '1.4.2' });
    expect(enqueue).toHaveBeenCalledWith({
      source: 'deployments',
      type: 'health.changed',
      orderingKey: `deployments/${PROJECT}/production`,
      payload: {
        kind: 'health',
        projectId: PROJECT,
        environment: 'production',
        state: 'degraded',
        previous: null,
        missed: 0,
        message: 'queue depth 40',
        version: '1.4.2',
        at: new Date(AT).toISOString(),
      },
    });
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain(token);
  });

  it('still stands when the change cannot be queued', async () => {
    enqueue.mockResolvedValue({ ok: false, err: { message: 'queue down' } });
    expect((await send('error', AT)).ok).toBe(true);
    enqueue.mockRejectedValue(new Error('no queue at all'));
    expect((await send('healthy', AT + MINUTE)).ok).toBe(true);
  });
});

describe('an application that went quiet', () => {
  it('is announced when someone looks, once per state the clock moves it into', async () => {
    await send('healthy', AT);
    enqueue.mockClear();
    expect(await settleHealth(await record(), new Date(AT + MINUTE))).toBeNull();
    expect(await settleHealth(await record(), new Date(AT + 2 * MINUTE))).toMatchObject({
      previous: 'healthy',
      state: 'late',
      missed: 1,
    });
    expect(await settleHealth(await record(), new Date(AT + 2 * MINUTE))).toBeNull();
    expect(await settleHealth(await record(), new Date(AT + 4 * MINUTE))).toMatchObject({
      previous: 'late',
      state: 'failed',
    });
    expect(queued()).toEqual([
      ['healthy', 'late'],
      ['late', 'failed'],
    ]);
  });

  it('is announced by one of two who looked at the same moment', async () => {
    await send('healthy', AT);
    enqueue.mockClear();
    const seen = await record();
    const both = await Promise.all([
      settleHealth(seen, new Date(AT + 2 * MINUTE)),
      settleHealth(seen, new Date(AT + 2 * MINUTE)),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('coming back is a change too', async () => {
    await send('healthy', AT);
    await settleHealth(await record(), new Date(AT + 4 * MINUTE));
    enqueue.mockClear();
    await send('healthy', AT + 5 * MINUTE);
    expect(queued()).toEqual([['failed', 'healthy']]);
  });
});

describe('raising', () => {
  it('answers whether the change was queued, and never throws', async () => {
    const change = {
      kind: 'deployment' as const,
      projectId: PROJECT,
      environment: 'production',
      status: 'failed' as const,
      deploymentId: 'd1',
      commit: 'f04b6e9aa1',
      branch: 'main',
      runUrl: null,
      detail: null,
      at: new Date(AT).toISOString(),
    };
    expect(await raiseChange(change)).toBe(true);
    expect(enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'deployments', type: 'deployment.changed' })
    );
    enqueue.mockRejectedValue(new Error('no queue'));
    expect(await raiseChange(change)).toBe(false);
  });
});
