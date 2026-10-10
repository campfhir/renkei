/**
 * The usage page's period and bucket arithmetic — kept apart from the
 * server action so it runs in a test without a database, the same split
 * the tools page (usage/window.ts), Organization Usage
 * (admin/usage/window.ts), and the person page (trend-window.ts) make.
 * This one generalizes the person page's token-only bucketing to every
 * series the page charts, so all of them bucket identically.
 */

import type { UsageSpan, UtilizationDay } from '@/lib/usage/user-utilization';

export { formatTokens } from '@/lib/format-tokens';
export type { UsageSpan };

export interface UtilizationPeriod extends UsageSpan {
  key: string;
  label: string;
}

/**
 * The windows the page offers. Today and yesterday are single days drawn
 * by the hour; the rest run up to and including today. A one-day window
 * that ends before today is what `endOffsetDays` is for — "yesterday" is
 * the only period whose newest day is not today.
 */
export const UTILIZATION_PERIODS: readonly UtilizationPeriod[] = [
  { key: 'today', label: 'Today', days: 1, endOffsetDays: 0 },
  { key: 'yesterday', label: 'Yesterday', days: 1, endOffsetDays: 1 },
  { key: '1w', label: '7 days', days: 7, endOffsetDays: 0 },
  { key: '1m', label: '30 days', days: 30, endOffsetDays: 0 },
  { key: '1q', label: '90 days', days: 90, endOffsetDays: 0 },
  { key: '1y', label: '1 year', days: 365, endOffsetDays: 0 },
];

export const DEFAULT_PERIOD_KEY = '1m';

/** A period key as typed by a client call — never trusted, always resolved. */
export function resolvePeriod(key: string | undefined): UtilizationPeriod {
  return (
    UTILIZATION_PERIODS.find((period) => period.key === key) ??
    UTILIZATION_PERIODS.find((period) => period.key === DEFAULT_PERIOD_KEY)!
  );
}

/** "Over the last 30 days", or "Today, by hour" for a one-day window. */
export function periodCaption(period: Pick<UtilizationPeriod, 'label' | 'days'>): string {
  return period.days <= 1 ? `${period.label}, by hour` : `Over the last ${period.label}`;
}

export type Granularity = 'hour' | 'day' | 'week' | 'month';

/** How wide a bucket has to be for a bar chart of the period to stay readable. */
export function granularityFor(days: number): Granularity {
  if (days <= 1) return 'hour';
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/** What the SQL groups rows by: the hour for a one-day window, the day otherwise. */
export function seriesGranularity(days: number): 'hour' | 'day' {
  return days <= 1 ? 'hour' : 'day';
}

export interface UtilizationBucket {
  /** Bucket start, YYYY-MM-DD (or YYYY-MM-DDTHH by the hour) — the x-axis key. */
  bucket: string;
  /** "Aug 12", "Aug 2026" for a monthly bucket, or "1 PM" for an hourly one. */
  label: string;
  inputTokens: number;
  outputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

/**
 * The calendar day `back` days before `now` in the viewer's zone. Today is
 * read in that zone (en-CA renders ISO order), then stepped as UTC
 * midnights purely as calendar arithmetic — so a DST boundary in the
 * viewer's zone cannot drop or duplicate a day.
 */
function localDay(now: Date, back: number, timeZone: string): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - back);
  return at.toISOString().slice(0, 10);
}

/** Every calendar day of the span, oldest first. */
function spanDays(span: UsageSpan, now: Date, timeZone: string): string[] {
  const days: string[] = [];
  for (let back = span.endOffsetDays + span.days - 1; back >= span.endOffsetDays; back -= 1) {
    days.push(localDay(now, back, timeZone));
  }
  return days;
}

const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const SHORT_MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const HOUR = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone: 'UTC' });

function bucketKeyOf(day: string, granularity: Granularity): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (granularity === 'day' || granularity === 'hour') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  const weekday = (date.getUTCDay() + 6) % 7; // 0 = Monday
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function labelOf(bucket: string, granularity: Granularity): string {
  if (granularity === 'hour') return HOUR.format(new Date(`${bucket}:00:00Z`));
  const date = new Date(`${bucket}T00:00:00Z`);
  return granularity === 'month' ? SHORT_MONTH.format(date) : SHORT_DATE.format(date);
}

/** The 24 hour keys of a calendar day, `YYYY-MM-DDTHH`. */
function hoursOf(day: string): string[] {
  return Array.from({ length: 24 }, (_, hour) => `${day}T${String(hour).padStart(2, '0')}`);
}

/** The keys the source rows are cut into: hours of the one day, or every day of the span. */
function seriesKeys(span: UsageSpan, now: Date, timeZone: string): string[] {
  const days = spanDays(span, now, timeZone);
  return span.days <= 1 ? hoursOf(days[0]!) : days;
}

/**
 * Every calendar day in the window — quiet ones included, in the viewer's
 * zone — grouped into buckets sized for the period, oldest first; for a
 * one-day window, its 24 hours instead. Zero-filling first and grouping
 * second is what keeps a quiet week honestly flat.
 */
export function bucketUtilization(
  rows: UtilizationDay[],
  span: UsageSpan,
  now: Date,
  timeZone: string
): UtilizationBucket[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const granularity = granularityFor(span.days);
  const buckets = new Map<string, UtilizationBucket>();
  for (const key of seriesKeys(span, now, timeZone)) {
    const bucketKey = bucketKeyOf(key, granularity);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        bucket: bucketKey,
        label: labelOf(bucketKey, granularity),
        inputTokens: 0,
        outputTokens: 0,
        runs: 0,
        failures: 0,
        toolCalls: 0,
        toolErrors: 0,
      };
      buckets.set(bucketKey, bucket);
    }
    const row = found.get(key);
    if (row) {
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.runs += row.runs;
      bucket.failures += row.failures;
      bucket.toolCalls += row.toolCalls;
      bucket.toolErrors += row.toolErrors;
    }
  }
  return [...buckets.values()];
}

/** Average tokens a run costs — the efficiency number; 0 when nothing ran. */
export function tokensPerRun(inputTokens: number, outputTokens: number, runs: number): number {
  if (runs <= 0) return 0;
  return Math.round((inputTokens + outputTokens) / runs);
}

/** The engine's error taxonomy, in words the owner will recognize. */
export function failureKindLabel(kind: string | null): string {
  switch (kind) {
    case 'step_failed':
      return 'a step failed';
    case 'llm_auth':
      return 'model credentials rejected';
    case 'llm_rate_limit':
      return 'model rate-limited';
    case 'llm_error':
      return 'model error';
    case 'timeout':
      return 'timed out';
    case 'guard':
      return 'hit a limit';
    case 'config':
      return 'configuration';
    case null:
      return 'failed';
    default:
      return kind.replace(/_/g, ' ');
  }
}
