import {
  failureKindLabel,
  formatTokens,
  granularityFor,
  periodCaption,
  resolvePeriod,
  seriesGranularity,
  tokensPerRun,
} from './window';

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
