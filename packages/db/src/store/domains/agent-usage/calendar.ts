import type { TokenBucketsRecord, UsageBucketsRecord } from './types';

export const ZERO_BUCKETS: UsageBucketsRecord = {
  today: 0,
  yesterday: 0,
  week: 0,
  month: 0,
  quarter: 0,
  year: 0,
  allTime: 0,
};

export const ZERO_TOKEN_BUCKETS: TokenBucketsRecord = {
  input: ZERO_BUCKETS,
  output: ZERO_BUCKETS,
  cacheRead: ZERO_BUCKETS,
  cacheWrite: ZERO_BUCKETS,
};

const DAY_MS = 86_400_000;

/** Days since the epoch of the UTC calendar date an instant falls on. */
function dayOf(at: Date): number {
  return Math.floor(at.getTime() / DAY_MS);
}

function dayOfUtc(year: number, month: number, date: number): number {
  return Math.floor(Date.UTC(year, month, date) / DAY_MS);
}

/**
 * The bucket edges for `now` on the UTC calendar: CURRENT_DATE, and the
 * date_trunc of it to the ISO week (Monday), month, quarter and year.
 */
function edgesAt(now: Date) {
  const today = dayOf(now);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const weekday = (now.getUTCDay() + 6) % 7; // Monday = 0
  return {
    today,
    week: today - weekday,
    month: dayOfUtc(year, month, 1),
    quarter: dayOfUtc(year, month - (month % 3), 1),
    year: dayOfUtc(year, 0, 1),
  };
}

/** Sum `value(row)` into the calendar buckets of each row's `at(row)` (nulls add nothing). */
export function bucketSums<T>(
  rows: readonly T[],
  at: (row: T) => Date,
  value: (row: T) => number | null,
  now: Date
): UsageBucketsRecord {
  const edges = edgesAt(now);
  const sums = { ...ZERO_BUCKETS };
  for (const row of rows) {
    const amount = value(row);
    if (amount === null) continue;
    const day = dayOf(at(row));
    sums.allTime += amount;
    if (day === edges.today) sums.today += amount;
    if (day === edges.today - 1) sums.yesterday += amount;
    if (day >= edges.week) sums.week += amount;
    if (day >= edges.month) sums.month += amount;
    if (day >= edges.quarter) sums.quarter += amount;
    if (day >= edges.year) sums.year += amount;
  }
  return sums;
}

/** Whether an instant falls on today's UTC date (CURRENT_DATE on a UTC session). */
export function isToday(at: Date, now: Date): boolean {
  return dayOf(at) === dayOf(now);
}
