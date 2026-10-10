import {
  bucketUtilization,
  failureKindLabel,
  formatTokens,
  granularityFor,
  periodCaption,
  resolvePeriod,
  seriesGranularity,
  tokensPerRun,
} from './window';

const NOW = new Date('2026-09-02T15:00:00Z');

const WEEK = { days: 7, endOffsetDays: 0 };
const TODAY = { days: 1, endOffsetDays: 0 };
const YESTERDAY = { days: 1, endOffsetDays: 1 };

describe('resolvePeriod', () => {
  it('resolves known keys and falls back to 30 days', () => {
    expect(resolvePeriod('1w').days).toBe(7);
    expect(resolvePeriod('1y').days).toBe(365);
    expect(resolvePeriod('today')).toMatchObject({ days: 1, endOffsetDays: 0 });
    expect(resolvePeriod('yesterday')).toMatchObject({ days: 1, endOffsetDays: 1 });
    expect(resolvePeriod('bogus').days).toBe(30);
    expect(resolvePeriod(undefined).days).toBe(30);
  });

  it('captions a one-day window by the hour', () => {
    expect(periodCaption(resolvePeriod('today'))).toBe('Today, by hour');
    expect(periodCaption(resolvePeriod('yesterday'))).toBe('Yesterday, by hour');
    expect(periodCaption(resolvePeriod('1w'))).toBe('Over the last 7 days');
  });
});

describe('granularityFor', () => {
  it('widens with the window', () => {
    expect(granularityFor(1)).toBe('hour');
    expect(granularityFor(7)).toBe('day');
    expect(granularityFor(30)).toBe('day');
    expect(granularityFor(90)).toBe('week');
    expect(granularityFor(365)).toBe('month');
    expect(seriesGranularity(1)).toBe('hour');
    expect(seriesGranularity(7)).toBe('day');
  });
});

describe('bucketUtilization', () => {
  it('zero-fills every day of a daily window, oldest first', () => {
    const buckets = bucketUtilization(
      [
        {
          day: '2026-09-01',
          inputTokens: 100,
          outputTokens: 20,
          runs: 2,
          failures: 1,
          toolCalls: 5,
          toolErrors: 1,
        },
      ],
      WEEK,
      NOW,
      'UTC'
    );
    expect(buckets).toHaveLength(7);
    expect(buckets[0]!.bucket).toBe('2026-08-27');
    expect(buckets[6]!.bucket).toBe('2026-09-02');
    const first = buckets[5]!;
    expect(first).toMatchObject({ bucket: '2026-09-01', inputTokens: 100, runs: 2, toolCalls: 5 });
    expect(buckets[0]).toMatchObject({ inputTokens: 0, runs: 0, toolCalls: 0, failures: 0 });
  });

  it('sums days into Monday-start weeks for a quarter', () => {
    const buckets = bucketUtilization(
      [
        {
          day: '2026-08-31',
          inputTokens: 1,
          outputTokens: 0,
          runs: 1,
          failures: 0,
          toolCalls: 0,
          toolErrors: 0,
        },
        {
          day: '2026-09-01',
          inputTokens: 2,
          outputTokens: 0,
          runs: 1,
          failures: 0,
          toolCalls: 3,
          toolErrors: 0,
        },
      ],
      { days: 90, endOffsetDays: 0 },
      NOW,
      'UTC'
    );
    const last = buckets[buckets.length - 1]!;
    // 2026-08-31 is a Monday, so both days land in the same week.
    expect(last.bucket).toBe('2026-08-31');
    expect(last.inputTokens).toBe(3);
    expect(last.runs).toBe(2);
    expect(last.toolCalls).toBe(3);
    expect(last.label).toBe('Aug 31');
  });

  it("ends on the viewer's today, not the server's", () => {
    // 15:00Z on Sep 2 is still Sep 2 in Honolulu but already Sep 3 in Auckland.
    expect(bucketUtilization([], WEEK, NOW, 'Pacific/Honolulu').at(-1)!.bucket).toBe('2026-09-02');
    expect(bucketUtilization([], WEEK, NOW, 'Pacific/Auckland').at(-1)!.bucket).toBe('2026-09-03');
  });

  it('buckets a year by month with month labels', () => {
    const buckets = bucketUtilization([], { days: 365, endOffsetDays: 0 }, NOW, 'UTC');
    expect(buckets[buckets.length - 1]).toMatchObject({ bucket: '2026-09-01', label: 'Sep 2026' });
    expect(buckets.length).toBeGreaterThanOrEqual(12);
  });

  it('draws today as 24 hours and yesterday as the day before', () => {
    const today = bucketUtilization(
      [
        {
          day: '2026-09-02T13',
          inputTokens: 5,
          outputTokens: 0,
          runs: 1,
          failures: 0,
          toolCalls: 2,
          toolErrors: 0,
        },
      ],
      TODAY,
      NOW,
      'UTC'
    );
    expect(today).toHaveLength(24);
    expect(today[0]).toMatchObject({ bucket: '2026-09-02T00', label: '12 AM' });
    expect(today[13]).toMatchObject({ bucket: '2026-09-02T13', label: '1 PM', inputTokens: 5 });

    const yesterday = bucketUtilization([], YESTERDAY, NOW, 'UTC');
    expect(yesterday).toHaveLength(24);
    expect(yesterday[0]!.bucket).toBe('2026-09-01T00');
    expect(yesterday[23]!.bucket).toBe('2026-09-01T23');
  });
});

describe('numbers', () => {
  it('tokensPerRun divides and rounds, and is 0 with no runs', () => {
    expect(tokensPerRun(1000, 500, 4)).toBe(375);
    expect(tokensPerRun(1000, 500, 0)).toBe(0);
  });
  it('formatTokens abbreviates', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_300_000)).toBe('2.3M');
  });
  it('failureKindLabel speaks plainly', () => {
    expect(failureKindLabel('step_failed')).toBe('a step failed');
    expect(failureKindLabel(null)).toBe('failed');
    expect(failureKindLabel('something_new')).toBe('something new');
  });
});
