/**
 * The one pure rule in the ledger: when a listing entry counts as "the file
 * we already hashed". Everything that can be unsure falls through to the
 * hash — the fast path may only ever skip on a full match.
 */

import { matchesProcessedStat, type ProcessedFileRow } from './processed-files';

const recorded: ProcessedFileRow = {
  contentHash: 'abc',
  path: '/in/a.pdf',
  size: 10,
  modifiedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('matchesProcessedStat', () => {
  it('matches when size and modified time both agree', () => {
    expect(
      matchesProcessedStat(recorded, { size: 10, modifiedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(true);
    expect(
      matchesProcessedStat(recorded, { size: 10, modifiedAt: new Date('2026-01-01T00:00:00Z') })
    ).toBe(true);
  });

  it('refuses on a different size or time', () => {
    expect(
      matchesProcessedStat(recorded, { size: 11, modifiedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(false);
    expect(
      matchesProcessedStat(recorded, { size: 10, modifiedAt: '2026-01-02T00:00:00.000Z' })
    ).toBe(false);
  });

  it('refuses whenever either side has no modified time — unsure means hash it', () => {
    expect(matchesProcessedStat(recorded, { size: 10, modifiedAt: null })).toBe(false);
    expect(
      matchesProcessedStat(
        { ...recorded, modifiedAt: null },
        { size: 10, modifiedAt: '2026-01-01T00:00:00.000Z' }
      )
    ).toBe(false);
    expect(
      matchesProcessedStat(recorded, { size: null, modifiedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(false);
    expect(matchesProcessedStat(recorded, { size: 10, modifiedAt: 'not a date' })).toBe(false);
  });
});
