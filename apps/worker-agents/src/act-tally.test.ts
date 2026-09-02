/**
 * The batch rule's bookkeeping, with no database: one insert per key per
 * run, every repeat an in-order update, and nothing after a failed insert.
 * The engine fires acts without awaiting them, so the case that matters is
 * the CONCURRENT one — thirteen claims in flight at once must still be one
 * row.
 */

import { createRunTally, talliedHeadline } from './act-tally';

function fakes() {
  const inserts: string[] = [];
  const updates: [string, number][] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    inserts,
    updates,
    release: () => release(),
    writes: {
      // The insert does not resolve until released: everything claimed in
      // the meantime is a repeat that has to wait for it.
      insert: async (id: string) => {
        inserts.push(id);
        await gate;
        return true;
      },
      update: async (id: string, count: number) => {
        updates.push([id, count]);
      },
    },
  };
}

describe('createRunTally', () => {
  it('inserts once and tallies every repeat, in order, even when the calls overlap', async () => {
    const tally = createRunTally();
    const { inserts, updates, release, writes } = fakes();

    const pending = ['a', 'b', 'c', 'd'].map((id) => tally.record('k', id, writes));
    // All four claimed while the insert is still in flight.
    expect(inserts).toEqual(['a']);
    expect(updates).toEqual([]);
    release();
    const outcomes = await Promise.all(pending);

    expect(outcomes).toEqual([
      { first: true, count: 1 },
      { first: false, count: 2 },
      { first: false, count: 3 },
      { first: false, count: 4 },
    ]);
    expect(inserts).toEqual(['a']);
    // Updates land on the FIRST call's id, after its insert, counting up.
    expect(updates).toEqual([
      ['a', 2],
      ['a', 3],
      ['a', 4],
    ]);
  });

  it('keeps keys apart', async () => {
    const tally = createRunTally();
    const { release, writes, inserts } = fakes();
    release();
    await tally.record('mark read', 'a', writes);
    await tally.record('archive', 'b', writes);
    await tally.record('archive', 'c', writes);
    expect(inserts).toEqual(['a', 'b']);
  });

  it('stays quiet after a failed insert rather than retrying per repeat', async () => {
    const tally = createRunTally();
    const updates: [string, number][] = [];
    const writes = {
      insert: async () => false,
      update: async (id: string, count: number) => {
        updates.push([id, count]);
      },
    };
    expect(await tally.record('k', 'a', writes)).toEqual({ first: true, count: 1 });
    expect(await tally.record('k', 'b', writes)).toEqual({ first: false, count: 2 });
    expect(updates).toEqual([]);
  });

  it('survives an insert that throws, and a repeat still counts', async () => {
    const tally = createRunTally();
    const writes = {
      insert: async () => {
        throw new Error('boom');
      },
      update: async () => undefined,
    };
    await expect(tally.record('k', 'a', writes)).resolves.toEqual({ first: true, count: 1 });
    await expect(tally.record('k', 'b', writes)).resolves.toEqual({ first: false, count: 2 });
  });
});

describe('talliedHeadline', () => {
  it('leaves a single act alone and counts the rest', () => {
    expect(talliedHeadline('Started archiving a batch of email', 1)).toBe(
      'Started archiving a batch of email'
    );
    expect(talliedHeadline('Started archiving a batch of email', 13)).toBe(
      'Started archiving a batch of email ×13'
    );
  });
});
