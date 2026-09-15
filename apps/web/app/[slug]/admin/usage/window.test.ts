import {
  activeUserPercent,
  bucketOrgSeries,
  formatTokens,
  granularityFor,
  resolvePeriod,
} from './window';

const NOW = new Date('2026-09-02T15:00:00Z');

const ZERO_DAY = {
  chatInputTokens: 0,
  chatOutputTokens: 0,
  chatProjectInputTokens: 0,
  chatProjectOutputTokens: 0,
  codeProjectInputTokens: 0,
  codeProjectOutputTokens: 0,
  agentInputTokens: 0,
  agentOutputTokens: 0,
  runs: 0,
  failures: 0,
  toolCalls: 0,
  toolErrors: 0,
};

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

describe('bucketOrgSeries', () => {
  it('zero-fills every day of a daily window and combines input/output per surface', () => {
    const buckets = bucketOrgSeries(
      [
        {
          ...ZERO_DAY,
          day: '2026-09-01',
          chatInputTokens: 100,
          chatOutputTokens: 20,
          agentInputTokens: 50,
          agentOutputTokens: 10,
          runs: 2,
          failures: 1,
          toolCalls: 5,
          toolErrors: 1,
        },
      ],
      7,
      NOW,
      'UTC'
    );
    expect(buckets).toHaveLength(7);
    expect(buckets[0]!.bucket).toBe('2026-08-27');
    expect(buckets[6]!.bucket).toBe('2026-09-02');
    const filled = buckets[5]!;
    expect(filled).toMatchObject({
      bucket: '2026-09-01',
      chatTokens: 120,
      agentTokens: 60,
      runs: 2,
      toolCalls: 5,
    });
    expect(buckets[0]).toMatchObject({ chatTokens: 0, runs: 0, toolCalls: 0, failures: 0 });
  });

  it('sums days into Monday-start weeks for a quarter', () => {
    const buckets = bucketOrgSeries(
      [
        { ...ZERO_DAY, day: '2026-08-31', chatInputTokens: 1, runs: 1 },
        { ...ZERO_DAY, day: '2026-09-01', chatInputTokens: 2, runs: 1, toolCalls: 3 },
      ],
      90,
      NOW,
      'UTC'
    );
    const last = buckets[buckets.length - 1]!;
    // 2026-08-31 is a Monday, so both days land in the same week.
    expect(last.bucket).toBe('2026-08-31');
    expect(last.chatTokens).toBe(3);
    expect(last.runs).toBe(2);
    expect(last.toolCalls).toBe(3);
    expect(last.label).toBe('Aug 31');
  });

  it("ends on the viewer's today, not the server's", () => {
    expect(bucketOrgSeries([], 7, NOW, 'Pacific/Honolulu').at(-1)!.bucket).toBe('2026-09-02');
    expect(bucketOrgSeries([], 7, NOW, 'Pacific/Auckland').at(-1)!.bucket).toBe('2026-09-03');
  });

  it('buckets a year by month with month labels', () => {
    const buckets = bucketOrgSeries([], 365, NOW, 'UTC');
    expect(buckets[buckets.length - 1]).toMatchObject({ bucket: '2026-09-01', label: 'Sep 2026' });
    expect(buckets.length).toBeGreaterThanOrEqual(12);
  });
});

describe('numbers', () => {
  it('formatTokens abbreviates', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_300_000)).toBe('2.3M');
  });

  it('activeUserPercent rounds and is 0 with no known users', () => {
    expect(activeUserPercent(3, 10)).toBe(30);
    expect(activeUserPercent(1, 3)).toBe(33);
    expect(activeUserPercent(0, 0)).toBe(0);
  });
});
