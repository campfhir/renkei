/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * recordItemOutcome's own contract: it's a distributed counter — the batch
 * only finalizes once succeeded+failed reaches total, the terminal status
 * reflects whether anything failed, and it never finalizes early (total
 * still null, or the count not yet complete) or twice (the guarded
 * WHERE status='running' on the finalize UPDATE — verified here by call
 * shape, since true concurrent-finisher races need a real database).
 */

jest.mock('kysely', () => ({ sql: Object.assign((..._args: unknown[]) => 'sql-fragment', {}) }));

import { recordItemOutcome } from './store';

interface Recorded {
  itemSet: Record<string, unknown> | null;
  batchSets: Record<string, unknown>[];
  finalizeWhereRan: boolean;
}

/** What the guarded terminal flip's RETURNING hands back when it wins. */
const FINALIZED_ROW = {
  id: 'batch-1',
  tenant_id: 'tenant-1',
  subject: 'auth0|alice',
  name: 'Nightly scans',
  kind: 'document-ocr-pipeline',
  config: {},
  total: 5,
  skipped: 0,
  last_error: null,
  schedule_id: null,
  started_at: new Date('2026-09-01T00:00:00Z'),
  finished_at: new Date('2026-09-01T01:00:00Z'),
  created_at: new Date('2026-09-01T00:00:00Z'),
};

/**
 * A minimal Kysely stand-in for recordItemOutcome's three sequential
 * updateTable calls: the item row, the atomic counter increment
 * (.returning), and — only when the counters say the batch is complete —
 * the guarded terminal-status flip (.returning too, so the winner learns
 * it won). `flipWins` false models a concurrent finisher having flipped
 * the row first: the guarded UPDATE matches nothing and returns nothing.
 */
function fakeDb(
  counterResult:
    | { succeeded: number; failed: number; total: number | null; skipped?: number }
    | undefined,
  flipWins = true
) {
  const recorded: Recorded = { itemSet: null, batchSets: [], finalizeWhereRan: false };
  let batchUpdateCount = 0;

  const db = {
    updateTable(table: string) {
      if (table === 'batch_job_items') {
        return {
          set(values: Record<string, unknown>) {
            recorded.itemSet = values;
            return this;
          },
          where: () => ({ execute: async () => undefined }),
        };
      }
      // batch_jobs: first call is the counter increment (.returning), any
      // further call is the terminal-status flip (guarded, no .returning).
      batchUpdateCount += 1;
      const isCounterUpdate = batchUpdateCount === 1;
      return {
        set(values: Record<string, unknown>) {
          recorded.batchSets.push(values);
          return this;
        },
        where(column: string, _op: string, value: unknown) {
          if (!isCounterUpdate && column === 'status' && value === 'running') {
            recorded.finalizeWhereRan = true;
          }
          return this;
        },
        returning: () => ({
          executeTakeFirst: async () => {
            if (isCounterUpdate) {
              return counterResult ? { ...FINALIZED_ROW, skipped: 0, ...counterResult } : undefined;
            }
            const status = recorded.batchSets[recorded.batchSets.length - 1]?.status;
            return flipWins
              ? { ...FINALIZED_ROW, ...counterResult, status }
              : undefined;
          },
        }),
        execute: async () => undefined,
      };
    },
  } as unknown as Parameters<typeof recordItemOutcome>[0];

  return { db, recorded };
}

describe('recordItemOutcome', () => {
  it('increments succeeded and does not finalize while total is still unknown', async () => {
    const { db, recorded } = fakeDb({ succeeded: 1, failed: 0, total: null });
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true, result: { pageCount: 3 } });

    expect(recorded.itemSet?.status).toBe('succeeded');
    expect(recorded.batchSets).toHaveLength(1); // only the counter increment
  });

  it('does not finalize before the count reaches total', async () => {
    const { db, recorded } = fakeDb({ succeeded: 2, failed: 0, total: 5 });
    const finalized = await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });
    expect(recorded.batchSets).toHaveLength(1);
    expect(finalized).toBeUndefined();
  });

  it('finalizes as succeeded when the last item lands with no failures', async () => {
    const { db, recorded } = fakeDb({ succeeded: 5, failed: 0, total: 5 });
    const finalized = await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });

    expect(recorded.batchSets).toHaveLength(2);
    expect(recorded.batchSets[1]?.status).toBe('succeeded');
    expect(recorded.finalizeWhereRan).toBe(true);
    // The winner gets the finalized row back — that is what tells the
    // handler it is the one call that announces the batch.
    expect(finalized).toMatchObject({ id: 'batch-1', status: 'succeeded', succeeded: 5, total: 5 });
  });

  it('hands the row to nobody when a concurrent finisher won the terminal flip', async () => {
    // Both finishers see the counters complete; only one guarded UPDATE
    // matches a 'running' row. The loser must not think it finalized.
    const { db, recorded } = fakeDb({ succeeded: 5, failed: 0, total: 5 }, false);
    const finalized = await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });
    expect(recorded.finalizeWhereRan).toBe(true);
    expect(finalized).toBeUndefined();
  });

  it('finalizes as partial when some items failed and some succeeded', async () => {
    const { db, recorded } = fakeDb({ succeeded: 3, failed: 2, total: 5 });
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: false, error: 'OCR failed' });

    expect(recorded.itemSet?.status).toBe('failed');
    expect(recorded.itemSet?.error).toBe('OCR failed');
    expect(recorded.batchSets[1]?.status).toBe('partial');
  });

  it('finalizes as failed when nothing succeeded', async () => {
    const { db, recorded } = fakeDb({ succeeded: 0, failed: 5, total: 5 });
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: false, error: 'quota exceeded' });
    expect(recorded.batchSets[1]?.status).toBe('failed');
  });

  it('counts a skipped item under skipped, and it completes the batch like any other', async () => {
    const { db, recorded } = fakeDb({ succeeded: 3, failed: 0, skipped: 2, total: 5 });
    const finalized = await recordItemOutcome(db, 'batch-1', 'item-1', {
      ok: true,
      skipped: true,
      result: { reason: 'already-processed' },
    });

    expect(recorded.itemSet?.status).toBe('skipped');
    // Skipped items neither help nor hurt the outcome: nothing failed, so succeeded.
    expect(recorded.batchSets[1]?.status).toBe('succeeded');
    expect(finalized).toMatchObject({ status: 'succeeded', skipped: 2 });
  });

  it('does not finalize while skipped + succeeded + failed is still short of total', async () => {
    const { db, recorded } = fakeDb({ succeeded: 1, failed: 0, skipped: 2, total: 5 });
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true, skipped: true });
    expect(recorded.batchSets).toHaveLength(1);
  });

  it('does nothing further when the batch row is gone (defensive)', async () => {
    const { db, recorded } = fakeDb(undefined);
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });
    expect(recorded.batchSets).toHaveLength(1); // no finalize attempt
  });
});
