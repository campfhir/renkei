/**
 * The usage chart's date arithmetic.
 *
 * A trend chart is a claim about time, and every bug here is a chart that
 * silently lies: a missing day reads as continuity, a wrong bucket reads as
 * activity at the wrong hour, and an unbounded window reads as a database
 * scan. Those are the three things pinned below.
 */

import {
  clampDays,
  safeTimeZone,
  localDay,
  zeroFill,
  resolveScope,
  canSeeOrgTop,
  type UsagePoint,
} from './window';

describe('resolveScope', () => {
  it('gives an operator the tenant-wide view by default', () => {
    expect(resolveScope(true, undefined)).toBe('tenant');
    expect(resolveScope(true, 'tenant')).toBe('tenant');
  });

  it('lets an operator narrow to their own calls', () => {
    expect(resolveScope(true, 'self')).toBe('self');
  });

  it('never widens for anyone else, however they ask', () => {
    // The whole point: this argument reaches the server function directly by
    // POST, not only through the toggle, so asking for 'tenant' must not be
    // a way to get it.
    expect(resolveScope(false, 'tenant')).toBe('self');
    expect(resolveScope(false, 'self')).toBe('self');
    expect(resolveScope(false, undefined)).toBe('self');
  });
});

describe('canSeeOrgTop', () => {
  it('shows an operator the org comparison even when narrowed to themselves', () => {
    // The two decisions are separate on purpose: an operator who has clicked
    // "Just me" is asking whose CALLS to chart, not giving up the comparison.
    expect(canSeeOrgTop(true)).toBe(true);
  });

  it('never shows it to anyone else', () => {
    expect(canSeeOrgTop(false)).toBe(false);
  });

  it('depends on the role alone', () => {
    // It takes no requested scope, which is what makes "ask for it by POST"
    // impossible rather than merely unhandled. If this signature ever grows a
    // caller-supplied argument, that is the moment to look hard at it.
    expect(canSeeOrgTop).toHaveLength(1);
  });
});

describe('clampDays', () => {
  it('keeps a sensible window as asked', () => {
    expect(clampDays(7)).toBe(7);
    expect(clampDays(90)).toBe(90);
  });

  it('bounds the window at both ends', () => {
    // 10_000 days is not a request, it is a table scan.
    expect(clampDays(10_000)).toBe(90);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(-5)).toBe(1);
  });

  it('falls back rather than passing garbage into an interval', () => {
    expect(clampDays(Number.NaN)).toBe(7);
    // Infinity is garbage rather than "as much as possible", so it takes the
    // default window instead of the maximum one.
    expect(clampDays(Number.POSITIVE_INFINITY)).toBe(7);
    expect(clampDays(7.9)).toBe(7);
  });
});

describe('safeTimeZone', () => {
  it('accepts a real IANA zone', () => {
    expect(safeTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for anything Postgres would reject', () => {
    // An unknown zone raises in Postgres, which would turn a bad browser
    // value into a failed page rather than a slightly wrong one.
    expect(safeTimeZone('Mars/Olympus_Mons')).toBe('UTC');
    expect(safeTimeZone('')).toBe('UTC');
    expect(safeTimeZone(undefined)).toBe('UTC');
  });
});

describe('localDay', () => {
  it('reports the viewer’s calendar day, not UTC’s', () => {
    // 03:30 UTC is still the previous evening in New York — the case where
    // "calls today" would otherwise be attributed to tomorrow.
    const at = new Date('2026-08-12T03:30:00Z');
    expect(localDay(at, 'UTC')).toBe('2026-08-12');
    expect(localDay(at, 'America/New_York')).toBe('2026-08-11');
  });
});

describe('zeroFill', () => {
  const point = (day: string, calls: number): UsagePoint => ({ day, calls, errors: 0 });
  const now = new Date('2026-08-12T12:00:00Z');

  it('returns one entry per day in the window', () => {
    const filled = zeroFill([], 7, 'UTC', now);
    expect(filled).toHaveLength(7);
    expect(filled[0]!.day).toBe('2026-08-06');
    expect(filled[6]!.day).toBe('2026-08-12');
  });

  it('fills a quiet day with zero instead of dropping it', () => {
    // The bug this exists for: Postgres returns only days that have rows, so
    // a chart drawn from them would join Monday to Thursday as if Tuesday and
    // Wednesday never happened.
    const filled = zeroFill([point('2026-08-10', 5), point('2026-08-12', 3)], 5, 'UTC', now);
    expect(filled.map((entry) => entry.calls)).toEqual([0, 0, 5, 0, 3]);
  });

  it('keeps the counts it was given', () => {
    const filled = zeroFill([{ day: '2026-08-12', calls: 9, errors: 2 }], 2, 'UTC', now);
    expect(filled[1]).toEqual({ day: '2026-08-12', calls: 9, errors: 2 });
  });

  it('ends on the viewer’s today, not UTC’s', () => {
    const justAfterUtcMidnight = new Date('2026-08-12T02:00:00Z');
    const filled = zeroFill([], 3, 'America/New_York', justAfterUtcMidnight);
    expect(filled[filled.length - 1]!.day).toBe('2026-08-11');
  });

  it('spans a DST boundary without dropping or repeating a day', () => {
    // US DST ends 2026-11-01. Stepping local midnights would produce a 25-hour
    // day here; the days are stepped as plain calendar dates for that reason.
    const afterFallBack = new Date('2026-11-03T12:00:00Z');
    const filled = zeroFill([], 5, 'America/New_York', afterFallBack);
    expect(filled.map((entry) => entry.day)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(new Set(filled.map((entry) => entry.day)).size).toBe(5);
  });
});
