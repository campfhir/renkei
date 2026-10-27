/**
 * The store-backed queue (`createPostgresQueue`) end to end on a memory
 * data store: the contract's policy (retry versus dead letter, release,
 * requeue) over the `queues` domain. The SQL half of the same calls is
 * held to these answers by @renkei/db's differential scenarios.
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { createPostgresQueue, webhookEventsQueue } from './postgres';

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

const queue = (maxAttempts: number) =>
  createPostgresQueue({
    table: 'events',
    deadLetterTable: 'events_dead_letters',
    policy: { maxAttempts, baseDelaySeconds: 30, maxDelaySeconds: 60 },
  });

async function claimOrThrow(q: ReturnType<typeof queue>) {
  const claimed = await q.consumer.claim();
  if (!claimed) throw new Error('nothing claimed');
  return claimed;
}

describe('createPostgresQueue on the data store', () => {
  it('delivers, and a failure within budget backs off', async () => {
    const q = queue(5);
    expect((await q.producer.enqueue({ source: 'webex', type: 't', payload: { a: 1 } })).ok).toBe(
      true
    );
    const first = await claimOrThrow(q);
    expect(first).toMatchObject({ source: 'webex', type: 't', payload: { a: 1 }, attempts: 1 });
    expect(await q.consumer.fail(first, 'boom')).toEqual({ status: 'retry', delaySeconds: 30 });
    expect(await q.consumer.claim()).toBeNull();
  });

  it('release hands the message back uncounted', async () => {
    const q = queue(5);
    await q.producer.enqueue({ source: 'webex', type: 't', payload: {} });
    const first = await claimOrThrow(q);
    await q.consumer.release(first);
    expect(await q.consumer.claim()).toMatchObject({ id: first.id, attempts: 1 });
  });

  it('a spent budget dead-letters; requeue brings it back fresh', async () => {
    const q = queue(1);
    await q.producer.enqueue({ source: 'webex', type: 't', payload: { a: 1 } });
    const first = await claimOrThrow(q);
    expect(await q.consumer.fail(first, 'dead now')).toEqual({ status: 'dead' });
    expect(await q.consumer.claim()).toBeNull();

    const dead = await q.deadLetters.list();
    expect(dead.ok && dead.val.map((d) => [d.id, d.lastError, d.attempts, d.payload])).toEqual([
      [first.id, 'dead now', 1, { a: 1 }],
    ]);
    expect(await q.deadLetters.requeue([first.id])).toEqual({ ok: true, val: 1 });
    expect(await q.consumer.claim()).toMatchObject({ id: first.id, attempts: 1 });
    expect(await q.deadLetters.purge([first.id])).toEqual({ ok: true, val: 0 });
  });

  it('completion is terminal', async () => {
    const embeddings = createPostgresQueue({
      table: 'embedding_jobs',
      deadLetterTable: 'embedding_jobs_dead_letters',
      clearPayloadOnComplete: true,
    });
    await embeddings.producer.enqueue({ source: 'k', type: 't', payload: { big: 'x' } });
    const claimed = await embeddings.consumer.claim();
    if (!claimed) throw new Error('nothing claimed');
    await embeddings.consumer.complete(claimed, 'skipped');
    expect(await embeddings.consumer.claim()).toBeNull();
  });

  it('refuses a table pair the store does not carry', async () => {
    const odd = createPostgresQueue({ table: 'events', deadLetterTable: 'elsewhere' });
    expect((await odd.producer.enqueue({ source: 's', type: 't', payload: {} })).ok).toBe(false);
    await expect(odd.consumer.claim()).rejects.toThrow('unknown queue events');
  });

  it('a consumer fixed on sources claims only those', async () => {
    const q = webhookEventsQueue({ sources: ['zoom'] });
    await q.producer.enqueue({ source: 'webex', type: 't', payload: {} });
    expect(await q.consumer.claim()).toBeNull();
    await q.producer.enqueue({ source: 'zoom', type: 't', payload: {} });
    expect(await q.consumer.claim()).toMatchObject({ source: 'zoom' });
  });
});
