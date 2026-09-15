/**
 * Organization Usage's period and bucket arithmetic — kept apart from the
 * server action so it runs in a test without a database, the same split
 * `utilization/window.ts` and `usage/window.ts` make.
 */

import type { OrgDay } from '@/lib/usage/org-usage';

export { formatTokens } from '@/lib/format-tokens';

export interface UsagePeriod {
  key: string;
  label: string;
  days: number;
}

export const ORG_USAGE_PERIODS: readonly UsagePeriod[] = [
  { key: '1w', label: '7 days', days: 7 },
  { key: '1m', label: '30 days', days: 30 },
  { key: '1q', label: '90 days', days: 90 },
  { key: '1y', label: '1 year', days: 365 },
];

export const DEFAULT_PERIOD_KEY = '1m';

/** A period key as typed by a client call — never trusted, always resolved. */
export function resolvePeriod(key: string | undefined): UsagePeriod {
  return (
    ORG_USAGE_PERIODS.find((period) => period.key === key) ??
    ORG_USAGE_PERIODS.find((period) => period.key === DEFAULT_PERIOD_KEY)!
  );
}

export type Granularity = 'day' | 'week' | 'month';

/** How wide a bucket has to be for a bar chart of the period to stay readable. */
export function granularityFor(days: number): Granularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

export interface OrgBucket {
  /** Bucket start, YYYY-MM-DD — the x-axis key. */
  bucket: string;
  /** "Aug 12", or "Aug 2026" for a monthly bucket. */
  label: string;
  chatTokens: number;
  chatProjectTokens: number;
  codeProjectTokens: number;
  agentTokens: number;
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
 * Every calendar day in the window — quiet ones included, in the viewer's
 * zone — grouped into buckets sized for the period, oldest first. Each
 * surface's input and output tokens are combined into one figure per
 * bucket; the split still shows in the headline stat tiles.
 */
export function bucketOrgSeries(
  rows: OrgDay[],
  days: number,
  now: Date,
  timeZone: string
): OrgBucket[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const granularity = granularityFor(days);
  const buckets = new Map<string, OrgBucket>();
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = localDay(now, back, timeZone);
    const row = found.get(day);
    const key = bucketKeyOf(day, granularity);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        bucket: key,
        label: labelOf(key, granularity),
        chatTokens: 0,
        chatProjectTokens: 0,
        codeProjectTokens: 0,
        agentTokens: 0,
        runs: 0,
        failures: 0,
        toolCalls: 0,
        toolErrors: 0,
      };
      buckets.set(key, bucket);
    }
    if (row) {
      bucket.chatTokens += row.chatInputTokens + row.chatOutputTokens;
      bucket.chatProjectTokens += row.chatProjectInputTokens + row.chatProjectOutputTokens;
      bucket.codeProjectTokens += row.codeProjectInputTokens + row.codeProjectOutputTokens;
      bucket.agentTokens += row.agentInputTokens + row.agentOutputTokens;
      bucket.runs += row.runs;
      bucket.failures += row.failures;
      bucket.toolCalls += row.toolCalls;
      bucket.toolErrors += row.toolErrors;
    }
  }
  return [...buckets.values()];
}

/** What share of the org signed in AND spent at least one token in the window. */
export function activeUserPercent(activeUsers: number, totalUsers: number): number {
  if (totalUsers <= 0) return 0;
  return Math.round((activeUsers / totalUsers) * 100);
}
