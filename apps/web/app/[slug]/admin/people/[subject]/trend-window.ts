/**
 * The person page's token trend chart: period choice, bucket size, and
 * zero-filling — kept apart from the server action so it can be tested
 * without a database, the same split the usage page's window.ts uses.
 *
 * Unlike the usage page's day-only trend, this one spans up to a year, so a
 * year drawn as 365 daily bars would be unreadable. The bucket widens with
 * the period: still daily up to a month, weekly for a quarter, monthly for
 * a year. Dates are stepped as UTC calendar days throughout — the source
 * rows (`agent_run_counters.day`) carry no timezone of their own (they are
 * already CURRENT_DATE-bucketed in Postgres, same as the token bucket
 * totals elsewhere in this file's siblings), so there is no viewer zone to
 * convert against here.
 */

export interface TrendPeriod {
  key: string;
  label: string;
  days: number;
}

export const TREND_PERIODS: readonly TrendPeriod[] = [
  { key: '1w', label: '1 week', days: 7 },
  { key: '2w', label: '2 weeks', days: 14 },
  { key: '1m', label: '1 month', days: 30 },
  { key: '1q', label: '1 quarter', days: 90 },
  { key: '1y', label: '1 year', days: 365 },
];

const DEFAULT_PERIOD = TREND_PERIODS[0]!;

/** A period key as typed by a client call — never trust it, resolve it. */
export function resolveTrendDays(key: string | undefined): number {
  return (TREND_PERIODS.find((period) => period.key === key) ?? DEFAULT_PERIOD).days;
}

export type Granularity = 'day' | 'week' | 'month';

/** How wide a bucket has to be for the chart to stay readable. */
export function granularityFor(days: number): Granularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

export interface DailyTokenRow {
  /** YYYY-MM-DD */
  day: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TrendBucket {
  /** Bucket start, YYYY-MM-DD — the x-axis key. */
  bucket: string;
  /** Short label for the axis: "Aug 12", "Aug 25", or "Aug 2026". */
  label: string;
  inputTokens: number;
  outputTokens: number;
}

/** UTC calendar date, YYYY-MM-DD, `back` days before `now`. */
function utcDay(now: Date, back: number): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  at.setUTCDate(at.getUTCDate() - back);
  return at.toISOString().slice(0, 10);
}

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const SHORT_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The bucket key a given day falls into, for the chosen granularity. */
function bucketKeyOf(day: string, granularity: Granularity): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  // Week: Monday-start, computed from the ISO weekday so a 7-day window
  // that happens to start mid-week still buckets consistently across calls.
  const weekday = (date.getUTCDay() + 6) % 7; // 0 = Monday
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function labelOf(bucket: string, granularity: Granularity): string {
  const date = new Date(`${bucket}T00:00:00Z`);
  return granularity === 'month' ? SHORT_MONTH.format(date) : SHORT_DATE.format(date);
}

/**
 * Every day in the window — including the quiet ones — grouped into
 * buckets sized for the period, oldest first.
 *
 * Postgres only returns days that have counter rows; a chart drawn straight
 * from `rows` would connect the days either side of a gap as though nothing
 * came between them. Zero-filling every calendar day first, then grouping,
 * is what keeps a quiet week honestly flat instead of invisible.
 */
export function bucketTokenTrend(rows: DailyTokenRow[], days: number, now: Date): TrendBucket[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const granularity = granularityFor(days);
  const buckets = new Map<string, TrendBucket>();

  for (let back = days - 1; back >= 0; back -= 1) {
    const day = utcDay(now, back);
    const row = found.get(day);
    const key = bucketKeyOf(day, granularity);
    const existing = buckets.get(key);
    if (existing) {
      existing.inputTokens += row?.inputTokens ?? 0;
      existing.outputTokens += row?.outputTokens ?? 0;
    } else {
      buckets.set(key, {
        bucket: key,
        label: labelOf(key, granularity),
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
      });
    }
  }

  return [...buckets.values()];
}
