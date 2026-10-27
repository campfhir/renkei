/**
 * The batch lifecycle on the memory data store (the Postgres side of the
 * same store calls is packages/db's differential suite).
 *
 * recordItemOutcome is a distributed counter: the batch only finalizes once
 * succeeded+failed+skipped reaches total, the terminal status reflects
 * whether anything failed, and it never finalizes early (total still null,
 * or the count not yet complete) or twice (the guarded flip — only a
 * 'running' batch is finalized, so a second finisher gets nothing back).
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import {
  activateBatch,
  beginDiscovery,
  claimItem,
  completeEmptyBatch,
  createBatch,
  failBatch,
  getBatch,
  getItem,
  insertItem,
  listBatches,
  listItems,
  recordItemOutcome,
} from './store';

let store: MemoryDataStore;

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
});

afterAll(() => {
  resetDataStore();
});

const BATCH = '00000000-0000-4000-8000-0000000000b1';

/** A running batch with these counters already in. */
async function seedRunning(counters: {
  total: number | null;
  succeeded?: number;
  failed?: number;
  skipped?: number;
}) {
  await store.seed({
    batch_jobs: [
      {
        id: BATCH,
        subject: 'auth0|alice',
        name: 'Nightly scans',
        kind: 'document-ocr-pipeline',
        status: 'running',
        ...counters,
      },
    ],
  });
  const item = await insertItem(BATCH, { documentKey: 'doc-1' });
  return item.id;
}

describe('recordItemOutcome', () => {
  it('increments succeeded and does not finalize while total is still unknown', async () => {
    const itemId = await seedRunning({ total: null });
    const finalized = await recordItemOutcome(BATCH, itemId, {
      ok: true,
      result: { pageCount: 3 },
    });

    expect(finalized).toBeUndefined();
    expect(await getItem(itemId)).toMatchObject({ status: 'succeeded', result: { pageCount: 3 } });
    expect(await getBatch(BATCH)).toMatchObject({ status: 'running', succeeded: 1 });
  });

  it('does not finalize before the count reaches total', async () => {
    const itemId = await seedRunning({ total: 5, succeeded: 1 });
    expect(await recordItemOutcome(BATCH, itemId, { ok: true })).toBeUndefined();
    expect((await getBatch(BATCH))?.status).toBe('running');
  });

  it('finalizes as succeeded when the last item lands with no failures', async () => {
    const itemId = await seedRunning({ total: 5, succeeded: 4 });
    const finalized = await recordItemOutcome(BATCH, itemId, { ok: true });
    // The winner gets the finalized row back — that is what tells the
    // handler it is the one call that announces the batch.
    expect(finalized).toMatchObject({ id: BATCH, status: 'succeeded', succeeded: 5, total: 5 });
    expect(finalized?.finished_at).toBeInstanceOf(Date);
  });

  it('hands the row to nobody when a concurrent finisher won the terminal flip', async () => {
    // Both finishers see the counters complete; only one guarded flip
    // matches a 'running' row. The loser must not think it finalized.
    const itemId = await seedRunning({ total: 2, succeeded: 0 });
    const other = await insertItem(BATCH, { documentKey: 'doc-2' });
    const first = await recordItemOutcome(BATCH, itemId, { ok: true });
    expect(first).toBeUndefined();
    const second = await recordItemOutcome(BATCH, other.id, { ok: true });
    expect(second?.status).toBe('succeeded');
    // A redelivered last item: counters are past total, but the batch is
    // no longer running, so nothing is handed back.
    expect(await recordItemOutcome(BATCH, other.id, { ok: true })).toBeUndefined();
  });

  it('finalizes as partial when some items failed and some succeeded', async () => {
    const itemId = await seedRunning({ total: 5, succeeded: 3, failed: 1 });
    const finalized = await recordItemOutcome(BATCH, itemId, { ok: false, error: 'OCR failed' });
    expect(await getItem(itemId)).toMatchObject({ status: 'failed', error: 'OCR failed' });
    expect(finalized?.status).toBe('partial');
  });

  it('finalizes as failed when nothing succeeded', async () => {
    const itemId = await seedRunning({ total: 5, failed: 4 });
    const finalized = await recordItemOutcome(BATCH, itemId, {
      ok: false,
      error: 'quota exceeded',
    });
    expect(finalized?.status).toBe('failed');
  });

  it('counts a skipped item under skipped, and it completes the batch like any other', async () => {
    const itemId = await seedRunning({ total: 5, succeeded: 3, skipped: 1 });
    const finalized = await recordItemOutcome(BATCH, itemId, {
      ok: true,
      skipped: true,
      result: { reason: 'already-processed' },
    });

    expect((await getItem(itemId))?.status).toBe('skipped');
    // Skipped items neither help nor hurt the outcome: nothing failed, so succeeded.
    expect(finalized).toMatchObject({ status: 'succeeded', skipped: 2, succeeded: 3 });
  });

  it('does not finalize while skipped + succeeded + failed is still short of total', async () => {
    const itemId = await seedRunning({ total: 5, succeeded: 1, skipped: 1 });
    expect(await recordItemOutcome(BATCH, itemId, { ok: true, skipped: true })).toBeUndefined();
    expect((await getBatch(BATCH))?.skipped).toBe(2);
  });

  it('does nothing further when the batch row is gone (defensive)', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    expect(await recordItemOutcome(missing, missing, { ok: true })).toBeUndefined();
  });
});

describe('the batch lifecycle', () => {
  it('claims discovery once, activates, and finalizes when every item already landed', async () => {
    const batch = await createBatch({
      subject: 'auth0|alice',
      name: 'Inbox',
      kind: 'document-ocr-pipeline',
      config: { shareId: 'share-1' },
    });
    expect(batch).toMatchObject({ status: 'queued', config: { shareId: 'share-1' } });

    expect((await beginDiscovery(batch.id))?.status).toBe('discovering');
    expect(await beginDiscovery(batch.id)).toBeUndefined();

    const item = await insertItem(batch.id, { documentKey: 'a' });
    await insertItem(
      batch.id,
      { documentKey: 'b' },
      { status: 'skipped', result: { reason: 'x' } }
    );
    expect((await claimItem(item.id))?.status).toBe('processing');
    expect(await claimItem(item.id)).toBeUndefined();
    // The fast item lands before activation knows the total…
    expect(await recordItemOutcome(batch.id, item.id, { ok: true })).toBeUndefined();
    // …so activation is the terminal transition.
    const activated = await activateBatch(batch.id, 2, 1);
    expect(activated).toMatchObject({ status: 'succeeded', total: 2, skipped: 1, succeeded: 1 });

    expect((await listItems(batch.id)).map((i) => i.payload.documentKey)).toEqual(['a', 'b']);
    expect((await listItems(batch.id, { status: 'skipped' })).map((i) => i.result)).toEqual([
      { reason: 'x' },
    ]);
  });

  it('fails and completes empty only from a live status', async () => {
    const one = await createBatch({ subject: 's', name: 'one', kind: 'k', config: {} });
    expect((await failBatch(one.id, 'boom'))?.last_error).toBe('boom');
    expect(await failBatch(one.id, 'again')).toBeUndefined();
    expect(await completeEmptyBatch(one.id, 2)).toBeUndefined();

    const two = await createBatch({ subject: 's', name: 'two', kind: 'k', config: {} });
    expect(await completeEmptyBatch(two.id, 2)).toMatchObject({
      status: 'succeeded',
      total: 2,
      skipped: 2,
    });
    expect((await listBatches('s', { status: 'failed' })).map((b) => b.name)).toEqual(['one']);
  });
});
