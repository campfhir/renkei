import {
  TREND_PERIODS,
  resolveTrendDays,
  granularityFor,
  bucketTokenTrend,
  type DailyTokenRow,
} from './trend-window';

describe('resolveTrendDays', () => {
  it('maps every listed period key to its day count', () => {
    expect(resolveTrendDays('1w')).toBe(7);
    expect(resolveTrendDays('2w')).toBe(14);
    expect(resolveTrendDays('1m')).toBe(30);
    expect(resolveTrendDays('1q')).toBe(90);
    expect(resolveTrendDays('1y')).toBe(365);
  });

  it('falls back to the first period for anything unrecognized', () => {
    // A stale client, or a tampered POST — never a table scan.
    expect(resolveTrendDays('decade')).toBe(TREND_PERIODS[0]!.days);
    expect(resolveTrendDays(undefined)).toBe(TREND_PERIODS[0]!.days);
  });
});

describe('granularityFor', () => {
  it('stays daily through a month', () => {
    expect(granularityFor(7)).toBe('day');
    expect(granularityFor(14)).toBe('day');
    expect(granularityFor(30)).toBe('day');
  });

  it('widens to weekly for a quarter', () => {
    expect(granularityFor(90)).toBe('week');
  });

  it('widens to monthly for a year', () => {
    expect(granularityFor(365)).toBe('month');
  });
});

describe('bucketTokenTrend', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const row = (day: string, inputTokens: number, outputTokens: number): DailyTokenRow => ({
    day,
    inputTokens,
    outputTokens,
  });

  it('returns one bucket per day when the window is daily-grained', () => {
    const buckets = bucketTokenTrend([], 7, now, 'UTC');
    expect(buckets).toHaveLength(7);
    expect(buckets[0]!.bucket).toBe('2026-08-06');
    expect(buckets[6]!.bucket).toBe('2026-08-12');
  });

  it('fills a quiet day with zero instead of dropping it', () => {
    const buckets = bucketTokenTrend(
      [row('2026-08-10', 500, 100), row('2026-08-12', 300, 50)],
      5,
      now,
      'UTC'
    );
    expect(buckets.map((bucket) => bucket.inputTokens)).toEqual([0, 0, 500, 0, 300]);
    expect(buckets.map((bucket) => bucket.outputTokens)).toEqual([0, 0, 100, 0, 50]);
  });

  it('sums a quarter window into weekly buckets', () => {
    const buckets = bucketTokenTrend(
      [row('2026-08-10', 100, 0), row('2026-08-11', 200, 0), row('2026-08-12', 50, 0)],
      90,
      now,
      'UTC'
    );
    expect(granularityFor(90)).toBe('week');
    // Fewer buckets than days: the whole point of widening the grain.
    // 90 days is ~13 weeks; partial weeks at either edge can round to 14.
    expect(buckets.length).toBeGreaterThanOrEqual(13);
    expect(buckets.length).toBeLessThanOrEqual(14);
    const last = buckets[buckets.length - 1]!;
    // Aug 10-12, 2026 falls in the Monday-Aug-10 week — all three days land
    // in the same bucket and sum together.
    expect(last.bucket).toBe('2026-08-10');
    expect(last.inputTokens).toBe(350);
  });

  it('sums a year window into monthly buckets', () => {
    // Both within the trailing 365-day window ending 2026-08-12.
    const buckets = bucketTokenTrend(
      [row('2026-08-01', 10, 0), row('2026-08-10', 20, 0)],
      365,
      now,
      'UTC'
    );
    expect(granularityFor(365)).toBe('month');
    const august = buckets.find((bucket) => bucket.bucket === '2026-08-01');
    expect(august?.inputTokens).toBe(30);
  });

  it('never drops or duplicates a day across a bucket boundary', () => {
    // Every input token in `rows` must land in exactly one output bucket.
    const rows = [row('2026-06-01', 7, 0), row('2026-07-15', 7, 0), row('2026-08-12', 7, 0)];
    const buckets = bucketTokenTrend(rows, 365, now, 'UTC');
    const total = buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
    expect(total).toBe(21);
  });

  it('labels a monthly bucket with month and year, not a bare date', () => {
    const buckets = bucketTokenTrend([], 365, now, 'UTC');
    expect(buckets[buckets.length - 1]!.label).toBe('Aug 2026');
  });
});
