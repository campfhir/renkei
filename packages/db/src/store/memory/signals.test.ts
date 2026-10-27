/**
 * The memory store's queue notify: an enqueue wakes a consumer waiting on
 * that queue at once, a wake that came between the claim and the wait is
 * not lost, and with nothing enqueued the wait runs out on its own.
 */

import { createMemoryDataStore } from './index';

const message = { source: 'agents', type: 'run', payload: { runId: 'r1' }, orderingKey: null };

describe('queueSignal', () => {
  it('wakes a waiting consumer as soon as its queue gets a message', async () => {
    const store = createMemoryDataStore();
    const signal = store.queueSignal('agent_jobs');
    const since = signal.version;
    const started = Date.now();
    const woken = signal.wait(since, 10_000);
    await store.queues.enqueue('agent_jobs', message);
    await woken;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal.version).toBe(since + 1);
  });

  it('returns at once when a message arrived after the version was read', async () => {
    const store = createMemoryDataStore();
    const signal = store.queueSignal('events');
    const since = signal.version;
    await store.queues.enqueue('events', message);
    const started = Date.now();
    await signal.wait(since, 10_000);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('is not woken by another queue, and runs out after the timeout', async () => {
    const store = createMemoryDataStore();
    const signal = store.queueSignal('events');
    const since = signal.version;
    await store.queues.enqueue('agent_jobs', message);
    const started = Date.now();
    await signal.wait(since, 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(signal.version).toBe(since);
  });

  it('wakes on a released message and on requeued dead letters too', async () => {
    const store = createMemoryDataStore();
    const signal = store.queueSignal('agent_jobs');
    await store.queues.enqueue('agent_jobs', message);
    const claimed = await store.queues.claim('agent_jobs', { staleClaimMinutes: 10 });
    if (!claimed) throw new Error('nothing claimed');
    let since = signal.version;
    await store.queues.release('agent_jobs', claimed.id, claimed.attempts);
    expect(signal.version).toBe(since + 1);

    const again = await store.queues.claim('agent_jobs', { staleClaimMinutes: 10 });
    if (!again) throw new Error('nothing claimed');
    await store.queues.deadLetter('agent_jobs', again.id, 'boom');
    since = signal.version;
    await store.queues.requeueDeadLetters('agent_jobs', [again.id]);
    expect(signal.version).toBe(since + 1);
  });
});
