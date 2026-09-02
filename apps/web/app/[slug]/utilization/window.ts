/**
 * The usage page's period and bucket arithmetic — kept apart from the
 * server action so it runs in a test without a database, the same split
 * the tools page (usage/window.ts) and the person page (trend-window.ts)
 * make. This one generalizes the person page's token-only bucketing to
 * every series the page charts, so all of them bucket identically.
 */

import type { UtilizationDay } from '@/lib/usage/user-utilization';

export interface UtilizationPeriod {
  key: string;
  label: string;
  days: number;
}

export const UTILIZATION_PERIODS: readonly UtilizationPeriod[] = [
  { key: '1w', label: '7 days', days: 7 },
  { key: '1m', label: '30 days', days: 30 },
  { key: '1q', label: '90 days', days: 90 },
  { key: '1y', label: '1 year', days: 365 },
];

export const DEFAULT_PERIOD_KEY = '1m';

/** A period key as typed by a client call — never trusted, always resolved. */
export function resolvePeriod(key: string | undefined): UtilizationPeriod {
  return (
    UTILIZATION_PERIODS.find((period) => period.key === key) ??
    UTILIZATION_PERIODS.find((period) => period.key === DEFAULT_PERIOD_KEY)!
  );
}

export type Granularity = 'day' | 'week' | 'month';

/** How wide a bucket has to be for a bar chart of the period to stay readable. */
export function granularityFor(days: number): Granularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

export interface UtilizationBucket {
  /** Bucket start, YYYY-MM-DD — the x-axis key. */
  bucket: string;
  /** "Aug 12", or "Aug 2026" for a monthly bucket. */
  label: string;
  inputTokens: number;
  outputTokens: number;
  runs: number;
  failures: number;
  toolCalls: number;
  toolErrors: number;
}

function utcDay(now: Date, back: number): string {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  at.setUTCDate(at.getUTCDate() - back);
  return at.toISOString().slice(0, 10);
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

function bucketKeyOf(day: string, granularity: Granularity): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (granularity === 'day') return day;
  if (granularity === 'month') return `${day.slice(0, 7)}-01`;
  const weekday = (date.getUTCDay() + 6) % 7; // 0 = Monday
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function labelOf(bucket: string, granularity: Granularity): string {
  const date = new Date(`${bucket}T00:00:00Z`);
  return granularity === 'month' ? SHORT_MONTH.format(date) : SHORT_DATE.format(date);
}

/**
 * Every calendar day in the window — quiet ones included — grouped into
 * buckets sized for the period, oldest first. Zero-filling first and
 * grouping second is what keeps a quiet week honestly flat.
 */
export function bucketUtilization(
  rows: UtilizationDay[],
  days: number,
  now: Date
): UtilizationBucket[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const granularity = granularityFor(days);
  const buckets = new Map<string, UtilizationBucket>();
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = utcDay(now, back);
    const row = found.get(day);
    const key = bucketKeyOf(day, granularity);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        bucket: key,
        label: labelOf(key, granularity),
        inputTokens: 0,
        outputTokens: 0,
        runs: 0,
        failures: 0,
        toolCalls: 0,
        toolErrors: 0,
      };
      buckets.set(key, bucket);
    }
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

/** 1234 → "1.2k", 1234567 → "1.2M"; small numbers as they are. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
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
