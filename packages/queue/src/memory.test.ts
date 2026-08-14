/**
 * The queue contract, exercised through the in-memory adapter: FIFO
 * delivery, attempt counting, retry backoff, ordering-key serialization
 * (the property that makes horizontal consumers safe), and the
 * dead-letter move/requeue/purge lifecycle.
 *
 * postgres.ts implements the same semantics in SQL; its claim query is
 * verified against a live database by the manual checklist in
 * DEPLOYMENT.md — the contract-level behavior is pinned here.
 */

import { InMemoryQueue } from './memory';
import type { ClaimedMessage } from './contract';

function input(over: Partial<{ type: string; orderingKey: string | null }> = {}) {
  return {
    tenantId: 'tenant-1',
    source: 'test',
    type: over.type ?? 'thing.happened',
    payload: { n: 1 },
    orderingKey: over.orderingKey ?? null,
  };
}

async function mustClaim(queue: InMemoryQueue): Promise<ClaimedMessage> {
  const message = await queue.consumer.claim();
  expect(message).not.toBeNull();
  return message!;
}

describe('delivery basics', () => {
  it('delivers oldest first and counts the delivery', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(input({ type: 'first' }));
    await queue.producer.enqueue(input({ type: 'second' }));

    const first = await mustClaim(queue);
    expect(first.type).toBe('first');
    expect(first.attempts).toBe(1);
  });

  it('returns null on an empty queue', async () => {
    expect(await new InMemoryQueue().consumer.claim()).toBeNull();
  });

  it('a claimed message is not redelivered while its lease holds', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(input());
    await mustClaim(queue);
    expect(await queue.consumer.claim()).toBeNull();
  });

  it('an expired lease makes the message reclaimable — crash recovery', async () => {
    // A negative lease expires instantly, even within the same millisecond.
    const queue = new InMemoryQueue({ leaseMs: -1 });
    await queue.producer.enqueue(input());
    const first = await mustClaim(queue);
    const again = await mustClaim(queue);
    expect(again.id).toBe(first.id);
    expect(again.attempts).toBe(2); // the crashed delivery still consumed an attempt
  });

  it('complete acks: the message never comes back', async () => {
    const queue = new InMemoryQueue({ leaseMs: -1 });
    await queue.producer.enqueue(input());
    const message = await mustClaim(queue);
    await queue.consumer.complete(message);
    expect(await queue.consumer.claim()).toBeNull();
    expect(queue.settled()).toBe(true);
  });
});

describe('retry and dead-letter lifecycle', () => {
  it('fail schedules a backoff retry per the policy', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(input());
    const message = await mustClaim(queue);
    const disposition = await queue.consumer.fail(message, 'boom');
    expect(disposition).toEqual({ status: 'retry', delaySeconds: 30 });
    // Not deliverable until the backoff elapses.
    expect(await queue.consumer.claim()).toBeNull();
    const row = queue.snapshot()[0]!;
    expect(row.status).toBe('pending');
    expect(row.runAfter).toBeGreaterThan(Date.now() + 20_000);
    expect(row.lastError).toBe('boom');
  });

  it('moves an exhausted message to the dead-letter store, out of the live queue', async () => {
    const queue = new InMemoryQueue({
      policy: { maxAttempts: 1, baseDelaySeconds: 1, maxDelaySeconds: 1 },
    });
    await queue.producer.enqueue(input({ type: 'poison' }));
    const message = await mustClaim(queue);
    const disposition = await queue.consumer.fail(message, 'unparseable');
    expect(disposition).toEqual({ status: 'dead' });

    expect(queue.snapshot()).toHaveLength(0); // moved, not flagged
    const listed = await queue.deadLetters.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.val).toHaveLength(1);
    expect(listed.val[0]).toMatchObject({ type: 'poison', attempts: 1, lastError: 'unparseable' });
  });

  it('requeues a dead letter with a fresh attempt budget — the reprocessing path', async () => {
    const queue = new InMemoryQueue({
      policy: { maxAttempts: 1, baseDelaySeconds: 1, maxDelaySeconds: 1 },
    });
    await queue.producer.enqueue(input({ type: 'poison' }));
    await queue.consumer.fail(await mustClaim(queue), 'transient outage');

    const dead = (await queue.deadLetters.list()).ok
      ? ((await queue.deadLetters.list()).val ?? [])
      : [];
    const requeued = await queue.deadLetters.requeue(dead.map((d) => d.id));
    expect(requeued).toEqual({ ok: true, val: 1 });

    const redelivered = await mustClaim(queue);
    expect(redelivered.type).toBe('poison');
    expect(redelivered.attempts).toBe(1); // budget reset
    expect((await queue.deadLetters.list()).ok && queue.deadSnapshot()).toHaveLength(0);
  });

  it('purges dead letters permanently, skipping unknown ids without error', async () => {
    const queue = new InMemoryQueue({
      policy: { maxAttempts: 1, baseDelaySeconds: 1, maxDelaySeconds: 1 },
    });
    await queue.producer.enqueue(input());
    await queue.consumer.fail(await mustClaim(queue), 'dead');
    const id = queue.deadSnapshot()[0]!.id;

    const purged = await queue.deadLetters.purge([id, 'no-such-id']);
    expect(purged).toEqual({ ok: true, val: 1 });
    expect(queue.deadSnapshot()).toHaveLength(0);
  });
});

describe('ordering keys — the horizontal-scaling contract', () => {
  it('serializes messages sharing a key: the second is invisible until the first completes', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(input({ type: 'purge', orderingKey: 'mailbox-a' }));
    await queue.producer.enqueue(input({ type: 'ingest', orderingKey: 'mailbox-a' }));

    const first = await mustClaim(queue);
    expect(first.type).toBe('purge');
    // A second consumer polling now — same queue, different worker — must
    // NOT receive the sibling. This is what makes N instances safe.
    expect(await queue.consumer.claim()).toBeNull();

    await queue.consumer.complete(first);
    const second = await mustClaim(queue);
    expect(second.type).toBe('ingest');
  });

  it('delivers distinct keys in parallel', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(input({ type: 'a1', orderingKey: 'key-a' }));
    await queue.producer.enqueue(input({ type: 'b1', orderingKey: 'key-b' }));
    await queue.producer.enqueue(input({ type: 'c1', orderingKey: null }));

    // Three concurrent claims — as if three worker instances polled at once.
    const claimed = [await mustClaim(queue), await mustClaim(queue), await mustClaim(queue)];
    expect(claimed.map((m) => m.type).sort()).toEqual(['a1', 'b1', 'c1']);
  });

  it('a keyed retry blocks its younger siblings until it drains — order survives failure', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(input({ type: 'older', orderingKey: 'key-a' }));
    await queue.producer.enqueue(input({ type: 'younger', orderingKey: 'key-a' }));

    const older = await mustClaim(queue);
    await queue.consumer.fail(older, 'transient');
    // The older sibling is backing off, still live — the younger must wait.
    expect(await queue.consumer.claim()).toBeNull();
  });

  it('dead-lettering a keyed message unblocks its siblings', async () => {
    const queue = new InMemoryQueue({
      policy: { maxAttempts: 1, baseDelaySeconds: 1, maxDelaySeconds: 1 },
    });
    await queue.producer.enqueue(input({ type: 'poison', orderingKey: 'key-a' }));
    await queue.producer.enqueue(input({ type: 'healthy', orderingKey: 'key-a' }));

    await queue.consumer.fail(await mustClaim(queue), 'dead');
    const next = await mustClaim(queue);
    expect(next.type).toBe('healthy');
  });
});

describe('source fixation and fair claiming', () => {
  function fromSource(source: string, type: string) {
    return { tenantId: 'tenant-1', source, type, payload: { n: 1 }, orderingKey: null };
  }

  it('a sources filter fixates the consumer, leaving other sources untouched', async () => {
    const queue = new InMemoryQueue({ sources: ['webex'] });
    await queue.producer.enqueue(fromSource('microsoft', 'noise'));
    await queue.producer.enqueue(fromSource('webex', 'chat'));

    const claimed = await mustClaim(queue);
    expect(claimed.source).toBe('webex');
    // The microsoft message stays for an unfixated instance — this
    // consumer never sees it.
    expect(await queue.consumer.claim()).toBeNull();
  });

  it('a fair claim serves a quiet source past an older backlog — no starvation', async () => {
    // The pick is uniform over sources sorted by name; a pinned random
    // makes it deterministic: 0.9 → the later source ('webex'), even
    // though every 'microsoft' message is older.
    const queue = new InMemoryQueue({ fairAcrossSources: true, random: () => 0.9 });
    for (let n = 0; n < 5; n += 1) await queue.producer.enqueue(fromSource('microsoft', `m${n}`));
    await queue.producer.enqueue(fromSource('webex', 'chat'));

    const claimed = await mustClaim(queue);
    expect(claimed.source).toBe('webex');
  });

  it('within the picked source, delivery is still oldest first', async () => {
    const queue = new InMemoryQueue({ fairAcrossSources: true, random: () => 0 });
    await queue.producer.enqueue(fromSource('microsoft', 'older'));
    await queue.producer.enqueue(fromSource('microsoft', 'younger'));
    await queue.producer.enqueue(fromSource('webex', 'chat'));

    const claimed = await mustClaim(queue);
    expect(claimed.source).toBe('microsoft');
    expect(claimed.type).toBe('older');
  });

  it('fairness with one backlogged source degrades to plain FIFO', async () => {
    const queue = new InMemoryQueue({ fairAcrossSources: true, random: () => 0.99 });
    await queue.producer.enqueue(fromSource('microsoft', 'first'));
    await queue.producer.enqueue(fromSource('microsoft', 'second'));

    expect((await mustClaim(queue)).type).toBe('first');
    expect((await mustClaim(queue)).type).toBe('second');
  });
});

describe('discardPending — the other half of a rebuild', () => {
  const ingest = (refId: string, project: string, content: string) => ({
    tenantId: 't1',
    source: 'knowledge',
    type: 'ingest.object',
    payload: { provider: 'jira', refId, content, metadata: { project } },
  });

  it('removes queued work that a rebuild has superseded', async () => {
    // Without this, deleting the chunks achieves nothing: the backlog
    // rewrites every one of them from content built before the upgrade.
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(ingest('ENG-1', 'ENG', 'old'));
    await queue.producer.enqueue(ingest('ENG-2', 'ENG', 'old'));

    const discarded = await queue.purger.discardPending('t1', 'ingest.object', [
      { path: ['provider'], value: 'jira' },
      { path: ['metadata', 'project'], value: 'ENG' },
    ]);

    expect(discarded.ok && discarded.val).toBe(2);
    expect(await queue.consumer.claim()).toBeNull();
  });

  it('leaves other scopes alone', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(ingest('ENG-1', 'ENG', 'old'));
    await queue.producer.enqueue(ingest('OPS-1', 'OPS', 'old'));

    await queue.purger.discardPending('t1', 'ingest.object', [
      { path: ['provider'], value: 'jira' },
      { path: ['metadata', 'project'], value: 'ENG' },
    ]);

    const claimed = await queue.consumer.claim();
    expect(claimed?.payload).toMatchObject({ refId: 'OPS-1' });
  });

  it('leaves another tenant’s work alone', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue({ ...ingest('ENG-1', 'ENG', 'old'), tenantId: 't2' });

    const discarded = await queue.purger.discardPending('t1', 'ingest.object', [
      { path: ['provider'], value: 'jira' },
      { path: ['metadata', 'project'], value: 'ENG' },
    ]);
    expect(discarded.ok && discarded.val).toBe(0);
  });

  it('does not touch a message someone is already working', async () => {
    // Pulling a claimed message out from under its consumer is a worse
    // problem than one stale row.
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(ingest('ENG-1', 'ENG', 'old'));
    const claimed = await queue.consumer.claim();
    expect(claimed).not.toBeNull();

    const discarded = await queue.purger.discardPending('t1', 'ingest.object', [
      { path: ['provider'], value: 'jira' },
      { path: ['metadata', 'project'], value: 'ENG' },
    ]);
    expect(discarded.ok && discarded.val).toBe(0);
  });

  it('refuses an empty predicate rather than matching everything', async () => {
    const queue = new InMemoryQueue();
    await queue.producer.enqueue(ingest('ENG-1', 'ENG', 'old'));

    const discarded = await queue.purger.discardPending('t1', 'ingest.object', []);
    expect(discarded.ok).toBe(false);
    // And the message it refused to match is still there.
    expect(await queue.consumer.claim()).not.toBeNull();
  });
});
