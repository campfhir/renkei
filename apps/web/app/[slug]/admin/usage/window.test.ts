import {
  activeSummary,
  activeUserPercent,
  activityCells,
  bucketImageSeries,
  bucketOrgSeries,
  calendarMonths,
  formatTokens,
  granularityFor,
  periodCaption,
  rankUsers,
  resolvePeriod,
  seriesGranularity,
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
      WEEK,
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
      { days: 90, endOffsetDays: 0 },
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
    expect(bucketOrgSeries([], WEEK, NOW, 'Pacific/Honolulu').at(-1)!.bucket).toBe('2026-09-02');
    expect(bucketOrgSeries([], WEEK, NOW, 'Pacific/Auckland').at(-1)!.bucket).toBe('2026-09-03');
  });

  it('buckets a year by month with month labels', () => {
    const buckets = bucketOrgSeries([], { days: 365, endOffsetDays: 0 }, NOW, 'UTC');
    expect(buckets[buckets.length - 1]).toMatchObject({ bucket: '2026-09-01', label: 'Sep 2026' });
    expect(buckets.length).toBeGreaterThanOrEqual(12);
  });

  it('draws today as 24 hours and yesterday as the day before', () => {
    const today = bucketOrgSeries(
      [{ ...ZERO_DAY, day: '2026-09-02T13', chatInputTokens: 5, toolCalls: 2 }],
      TODAY,
      NOW,
      'UTC'
    );
    expect(today).toHaveLength(24);
    expect(today[0]).toMatchObject({ bucket: '2026-09-02T00', label: '12 AM' });
    expect(today[13]).toMatchObject({ bucket: '2026-09-02T13', label: '1 PM', chatTokens: 5 });

    const yesterday = bucketOrgSeries([], YESTERDAY, NOW, 'UTC');
    expect(yesterday).toHaveLength(24);
    expect(yesterday[0]!.bucket).toBe('2026-09-01T00');
    expect(yesterday[23]!.bucket).toBe('2026-09-01T23');
  });
});

describe('activityCells', () => {
  it('marks a day active for tokens, runs or tool calls alone, and shades by tokens', () => {
    const cells = activityCells(
      [
        { ...ZERO_DAY, day: '2026-08-28', toolCalls: 3 },
        { ...ZERO_DAY, day: '2026-08-30', chatInputTokens: 100 },
        { ...ZERO_DAY, day: '2026-09-01', agentInputTokens: 30 },
        { ...ZERO_DAY, day: '2026-09-02', runs: 1 },
      ],
      WEEK,
      NOW,
      'UTC'
    );
    expect(cells.map((cell) => cell.key)).toEqual([
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
    expect(cells.map((cell) => cell.active)).toEqual([false, true, false, true, false, true, true]);
    // Tool calls alone are the lightest shade; the busiest day is the darkest.
    expect(cells.map((cell) => cell.level)).toEqual([0, 1, 0, 4, 0, 2, 1]);
    expect(cells[3]!.label).toBe('Aug 30');
    expect(activeSummary(cells)).toEqual({ active: 4, total: 7 });
  });

  it('counts hours for a one-day window', () => {
    const cells = activityCells(
      [{ ...ZERO_DAY, day: '2026-09-01T09', chatInputTokens: 1 }],
      YESTERDAY,
      NOW,
      'UTC'
    );
    expect(cells).toHaveLength(24);
    expect(cells[9]).toMatchObject({ label: '9 AM', active: true, level: 4 });
    expect(activeSummary(cells)).toEqual({ active: 1, total: 24 });
  });
});

describe('calendarMonths', () => {
  it('lays days out per month, aligned to Monday-first weekdays, with blanks outside the window', () => {
    const months = calendarMonths(activityCells([], WEEK, NOW, 'UTC'));
    expect(months.map((month) => month.key)).toEqual(['2026-08', '2026-09']);
    const [august, september] = months;
    // 1 Aug 2026 is a Saturday: five blank columns before it.
    expect(august).toMatchObject({ label: 'Aug', leading: 5 });
    expect(august!.days).toHaveLength(31);
    expect(august!.days.slice(0, 26).every((day) => day === null)).toBe(true);
    expect(august!.days[26]!.key).toBe('2026-08-27');
    // 1 Sep 2026 is a Tuesday.
    expect(september).toMatchObject({ label: 'Sep', leading: 1 });
    expect(september!.days).toHaveLength(30);
    expect(september!.days[1]!.key).toBe('2026-09-02');
    expect(september!.days[2]).toBeNull();
  });
});

describe('rankUsers', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((subject, index) => ({
    subject,
    label: subject.toUpperCase(),
    chatTokens: 100 - index,
    agentTokens: 0,
    totalTokens: 100 - index,
  }));

  it('keeps the top rows and finds the selected person wherever they rank', () => {
    const { top, selected } = rankUsers(rows, 'g');
    expect(top.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(selected).toMatchObject({ subject: 'g', rank: 7 });
  });

  it('reports a top-ranked person with their in-list rank, and nobody when unranked', () => {
    expect(rankUsers(rows, 'b').selected).toMatchObject({ rank: 2 });
    expect(rankUsers(rows, 'zzz').selected).toBeNull();
    expect(rankUsers(rows, null).selected).toBeNull();
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

describe('bucketImageSeries', () => {
  const day = (key: string, images: number, bytes: number, inputTokens = 0, outputTokens = 0) => ({
    day: key,
    images,
    bytes,
    inputTokens,
    outputTokens,
  });

  it('draws a one-day window by the hour — all 24, quiet ones zero', () => {
    const buckets = bucketImageSeries(
      [day('2026-09-02T09', 2, 3_000_000, 100, 4_000), day('2026-09-02T14', 1, 500_000)],
      TODAY,
      NOW,
      'UTC'
    );
    expect(buckets).toHaveLength(24);
    expect(buckets[0]).toMatchObject({
      bucket: '2026-09-02T00',
      label: '12 AM',
      images: 0,
      bytes: 0,
    });
    expect(buckets[9]).toMatchObject({
      bucket: '2026-09-02T09',
      label: '9 AM',
      images: 2,
      bytes: 3_000_000,
      inputTokens: 100,
      outputTokens: 4_000,
    });
    expect(buckets[14]).toMatchObject({ label: '2 PM', images: 1, bytes: 500_000 });
    expect(buckets.reduce((sum, b) => sum + b.bytes, 0)).toBe(3_500_000);
  });

  it('reads yesterday by the hour too, on yesterday’s date', () => {
    const buckets = bucketImageSeries([day('2026-09-01T23', 1, 10)], YESTERDAY, NOW, 'UTC');
    expect(buckets).toHaveLength(24);
    expect(buckets[0]!.bucket).toBe('2026-09-01T00');
    expect(buckets[23]).toMatchObject({ label: '11 PM', bytes: 10 });
  });

  it('zero-fills every day of a week, oldest first', () => {
    const buckets = bucketImageSeries([day('2026-09-01', 3, 4_000_000)], WEEK, NOW, 'UTC');
    expect(buckets.map((b) => b.bucket)).toEqual([
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
    expect(buckets[5]).toMatchObject({ label: 'Sep 1', images: 3, bytes: 4_000_000 });
    expect(buckets.filter((b) => b.bytes > 0)).toHaveLength(1);
  });

  it('folds a quarter into weeks starting Monday, summing what fell in each', () => {
    const buckets = bucketImageSeries(
      [day('2026-08-31', 1, 100), day('2026-09-01', 2, 200), day('2026-09-02', 1, 50, 7, 3)],
      { days: 90, endOffsetDays: 0 },
      NOW,
      'UTC'
    );
    // 2026-08-31 is a Monday: that day, the 1st and the 2nd share a week.
    const week = buckets.find((b) => b.bucket === '2026-08-31')!;
    expect(week).toMatchObject({ images: 4, bytes: 350, inputTokens: 7, outputTokens: 3 });
    expect(buckets.length).toBeLessThan(20);
    expect(buckets.reduce((sum, b) => sum + b.bytes, 0)).toBe(350);
  });

  it('folds a year into months', () => {
    const buckets = bucketImageSeries(
      [day('2026-08-15', 1, 1_000), day('2026-08-20', 1, 2_000), day('2026-09-02', 1, 5)],
      { days: 365, endOffsetDays: 0 },
      NOW,
      'UTC'
    );
    expect(buckets).toHaveLength(13);
    expect(buckets.find((b) => b.bucket === '2026-08-01')).toMatchObject({
      label: 'Aug 2026',
      images: 2,
      bytes: 3_000,
    });
    expect(buckets[buckets.length - 1]).toMatchObject({ bucket: '2026-09-01', bytes: 5 });
  });

  it('is all zeros for a window with no pictures, and ignores rows outside the window', () => {
    const empty = bucketImageSeries([], WEEK, NOW, 'UTC');
    expect(empty).toHaveLength(7);
    expect(empty.every((b) => b.images === 0 && b.bytes === 0)).toBe(true);
    const stray = bucketImageSeries([day('2020-01-01', 9, 9)], WEEK, NOW, 'UTC');
    expect(stray.every((b) => b.bytes === 0)).toBe(true);
  });

  it('cuts days in the viewer’s zone', () => {
    // 15:00 UTC on the 2nd is 08:00 on the 2nd in Los Angeles; hours are local.
    const buckets = bucketImageSeries(
      [day('2026-09-02T08', 1, 1)],
      TODAY,
      NOW,
      'America/Los_Angeles'
    );
    expect(buckets).toHaveLength(24);
    expect(buckets[8]).toMatchObject({ bucket: '2026-09-02T08', label: '8 AM', bytes: 1 });
  });
});
