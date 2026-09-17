/**
 * Organization Usage's period and bucket arithmetic — kept apart from the
 * server action so it runs in a test without a database, the same split
 * `utilization/window.ts` and `usage/window.ts` make.
 */

import type { OrgDay, TopUserRow, UsageSpan } from '@/lib/usage/org-usage';

export { formatTokens } from '@/lib/format-tokens';

export interface UsagePeriod extends UsageSpan {
  key: string;
  label: string;
}

/**
 * The windows the page offers. Today and yesterday are single days drawn
 * by the hour; the rest run up to and including today. A one-day window
 * that ends before today is what `endOffsetDays` is for — "yesterday" is
 * the only period whose newest day is not today.
 */
export const ORG_USAGE_PERIODS: readonly UsagePeriod[] = [
  { key: 'today', label: 'Today', days: 1, endOffsetDays: 0 },
  { key: 'yesterday', label: 'Yesterday', days: 1, endOffsetDays: 1 },
  { key: '1w', label: '7 days', days: 7, endOffsetDays: 0 },
  { key: '1m', label: '30 days', days: 30, endOffsetDays: 0 },
  { key: '1q', label: '90 days', days: 90, endOffsetDays: 0 },
  { key: '1y', label: '1 year', days: 365, endOffsetDays: 0 },
];

export const DEFAULT_PERIOD_KEY = '1m';

/** A period key as typed by a client call — never trusted, always resolved. */
export function resolvePeriod(key: string | undefined): UsagePeriod {
  return (
    ORG_USAGE_PERIODS.find((period) => period.key === key) ??
    ORG_USAGE_PERIODS.find((period) => period.key === DEFAULT_PERIOD_KEY)!
  );
}

/** "Over the last 30 days", or "Today, by hour" for a one-day window. */
export function periodCaption(period: Pick<UsagePeriod, 'label' | 'days'>): string {
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

export interface OrgBucket {
  /** Bucket start, YYYY-MM-DD (or YYYY-MM-DDTHH by the hour) — the x-axis key. */
  bucket: string;
  /** "Aug 12", "Aug 2026" for a monthly bucket, or "1 PM" for an hourly one. */
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
const MONTH_ONLY = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
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

function emptyBucket(key: string, label: string): OrgBucket {
  return {
    bucket: key,
    label,
    chatTokens: 0,
    chatProjectTokens: 0,
    codeProjectTokens: 0,
    agentTokens: 0,
    runs: 0,
    failures: 0,
    toolCalls: 0,
    toolErrors: 0,
  };
}

function addRow(bucket: OrgBucket, row: OrgDay): void {
  bucket.chatTokens += row.chatInputTokens + row.chatOutputTokens;
  bucket.chatProjectTokens += row.chatProjectInputTokens + row.chatProjectOutputTokens;
  bucket.codeProjectTokens += row.codeProjectInputTokens + row.codeProjectOutputTokens;
  bucket.agentTokens += row.agentInputTokens + row.agentOutputTokens;
  bucket.runs += row.runs;
  bucket.failures += row.failures;
  bucket.toolCalls += row.toolCalls;
  bucket.toolErrors += row.toolErrors;
}

/**
 * Every calendar day in the window — quiet ones included, in the viewer's
 * zone — grouped into buckets sized for the period, oldest first; for a
 * one-day window, its 24 hours instead. Each surface's input and output
 * tokens are combined into one figure per bucket; the split still shows
 * in the headline stat tiles.
 */
export function bucketOrgSeries(
  rows: OrgDay[],
  span: UsageSpan,
  now: Date,
  timeZone: string
): OrgBucket[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const granularity = granularityFor(span.days);
  const buckets = new Map<string, OrgBucket>();
  for (const key of seriesKeys(span, now, timeZone)) {
    const bucketKey = bucketKeyOf(key, granularity);
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = emptyBucket(bucketKey, labelOf(bucketKey, granularity));
      buckets.set(bucketKey, bucket);
    }
    const row = found.get(key);
    if (row) addRow(bucket, row);
  }
  return [...buckets.values()];
}

/** What share of the org signed in AND spent at least one token in the window. */
export function activeUserPercent(activeUsers: number, totalUsers: number): number {
  if (totalUsers <= 0) return 0;
  return Math.round((activeUsers / totalUsers) * 100);
}

/**
 * One square of the activity calendar: a day (or an hour of a one-day
 * window), whether anything at all happened in it, and how much relative
 * to the busiest square — `level` 0 is quiet, 1–4 shade up by tokens.
 * A square with tool calls but no tokens (someone working from a chat
 * client, whose model spend is not ours) still counts as active, at the
 * lightest shade.
 */
export interface ActivityCell {
  key: string;
  /** "Sep 14", or "1 PM" for an hour. */
  label: string;
  tokens: number;
  runs: number;
  toolCalls: number;
  active: boolean;
  level: 0 | 1 | 2 | 3 | 4;
}

export function activityCells(
  rows: OrgDay[],
  span: UsageSpan,
  now: Date,
  timeZone: string
): ActivityCell[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const granularity: Granularity = span.days <= 1 ? 'hour' : 'day';
  const cells: ActivityCell[] = seriesKeys(span, now, timeZone).map((key) => {
    const row = found.get(key);
    const tokens = row
      ? row.chatInputTokens +
        row.chatOutputTokens +
        row.chatProjectInputTokens +
        row.chatProjectOutputTokens +
        row.codeProjectInputTokens +
        row.codeProjectOutputTokens +
        row.agentInputTokens +
        row.agentOutputTokens
      : 0;
    const runs = row?.runs ?? 0;
    const toolCalls = row?.toolCalls ?? 0;
    return {
      key,
      label: labelOf(key, granularity),
      tokens,
      runs,
      toolCalls,
      active: tokens > 0 || runs > 0 || toolCalls > 0,
      level: 0,
    };
  });
  const peak = Math.max(0, ...cells.map((cell) => cell.tokens));
  for (const cell of cells) {
    if (!cell.active) continue;
    if (peak === 0 || cell.tokens === 0) {
      cell.level = 1;
      continue;
    }
    const share = cell.tokens / peak;
    cell.level = share > 0.75 ? 4 : share > 0.5 ? 3 : share > 0.25 ? 2 : 1;
  }
  return cells;
}

/** "5 / 7": squares with any activity against squares in the window. */
export function activeSummary(cells: readonly ActivityCell[]): { active: number; total: number } {
  return { active: cells.filter((cell) => cell.active).length, total: cells.length };
}

export interface CalendarMonth {
  /** YYYY-MM. */
  key: string;
  /** "Sep". */
  label: string;
  /** Empty columns before the 1st, so the 1st lands on its weekday (Monday first). */
  leading: number;
  /** One entry per day of the month, in order; null for a day outside the window. */
  days: (ActivityCell | null)[];
}

/**
 * Day cells laid out as tiny month calendars, one per month the window
 * touches, seven columns wide and aligned to the real weekday of each
 * date — so a square is read the way a calendar is, not by counting from
 * the left edge. Days of a month that fall outside the window are kept as
 * blanks so the shape of the month stays true. Only meaningful for day
 * cells; hourly cells are drawn as a single strip instead.
 */
export function calendarMonths(cells: readonly ActivityCell[]): CalendarMonth[] {
  const byDay = new Map(cells.map((cell) => [cell.key, cell]));
  const months = new Map<string, CalendarMonth>();
  for (const cell of cells) {
    const monthKey = cell.key.slice(0, 7);
    if (months.has(monthKey)) continue;
    const first = new Date(`${monthKey}-01T00:00:00Z`);
    const daysInMonth = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
    ).getUTCDate();
    const days: (ActivityCell | null)[] = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      days.push(byDay.get(`${monthKey}-${String(day).padStart(2, '0')}`) ?? null);
    }
    months.set(monthKey, {
      key: monthKey,
      label: MONTH_ONLY.format(first),
      leading: (first.getUTCDay() + 6) % 7,
      days,
    });
  }
  return [...months.values()];
}

export interface RankedUserRow extends TopUserRow {
  /** 1-based position among everyone who spent anything in the window. */
  rank: number;
}

/**
 * The leaderboard's top rows, plus where one person stands in the full
 * ranking — their own row with its rank, whether or not it made the top.
 * The rows in between are not returned: "#9" says enough on its own.
 */
export function rankUsers(
  rows: readonly TopUserRow[],
  subject: string | null,
  top = 5
): { top: RankedUserRow[]; selected: RankedUserRow | null } {
  const ranked = rows.map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    top: ranked.slice(0, top),
    selected: subject === null ? null : (ranked.find((row) => row.subject === subject) ?? null),
  };
}
