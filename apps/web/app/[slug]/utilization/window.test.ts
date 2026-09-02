import {
  bucketUtilization,
  failureKindLabel,
  formatTokens,
  granularityFor,
  resolvePeriod,
  tokensPerRun,
} from './window';

const NOW = new Date('2026-09-02T15:00:00Z');

describe('resolvePeriod', () => {
  it('resolves known keys and falls back to 30 days', () => {
    expect(resolvePeriod('1w').days).toBe(7);
    expect(resolvePeriod('1y').days).toBe(365);
    expect(resolvePeriod('bogus').days).toBe(30);
    expect(resolvePeriod(undefined).days).toBe(30);
  });
});

describe('granularityFor', () => {
  it('widens with the window', () => {
    expect(granularityFor(7)).toBe('day');
    expect(granularityFor(30)).toBe('day');
    expect(granularityFor(90)).toBe('week');
    expect(granularityFor(365)).toBe('month');
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
      7,
      NOW
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
      90,
      NOW
    );
    const last = buckets[buckets.length - 1]!;
    // 2026-08-31 is a Monday, so both days land in the same week.
    expect(last.bucket).toBe('2026-08-31');
    expect(last.inputTokens).toBe(3);
    expect(last.runs).toBe(2);
    expect(last.toolCalls).toBe(3);
    expect(last.label).toBe('Aug 31');
  });

  it('buckets a year by month with month labels', () => {
    const buckets = bucketUtilization([], 365, NOW);
    expect(buckets[buckets.length - 1]).toMatchObject({ bucket: '2026-09-01', label: 'Sep 2026' });
    expect(buckets.length).toBeGreaterThanOrEqual(12);
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
