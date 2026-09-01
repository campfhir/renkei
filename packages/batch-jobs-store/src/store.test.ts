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

/**
 * A minimal Kysely stand-in for recordItemOutcome's three sequential
 * updateTable calls: the item row, the atomic counter increment
 * (.returning), and — only when the counters say the batch is complete —
 * the guarded terminal-status flip.
 */
function fakeDb(counterResult: { succeeded: number; failed: number; total: number | null } | undefined) {
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
        returning: () => ({ executeTakeFirst: async () => counterResult }),
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
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });
    expect(recorded.batchSets).toHaveLength(1);
  });

  it('finalizes as succeeded when the last item lands with no failures', async () => {
    const { db, recorded } = fakeDb({ succeeded: 5, failed: 0, total: 5 });
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });

    expect(recorded.batchSets).toHaveLength(2);
    expect(recorded.batchSets[1]?.status).toBe('succeeded');
    expect(recorded.finalizeWhereRan).toBe(true);
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

  it('does nothing further when the batch row is gone (defensive)', async () => {
    const { db, recorded } = fakeDb(undefined);
    await recordItemOutcome(db, 'batch-1', 'item-1', { ok: true });
    expect(recorded.batchSets).toHaveLength(1); // no finalize attempt
  });
});
