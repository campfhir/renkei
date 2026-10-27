/**
 * The window and bucketing every usage read shares, in both stores.
 *
 * A window is a half-open range of instants — `since` inclusive, `until`
 * exclusive, or open-ended when `until` is null/absent (a row written a
 * second from now still counts). The caller works out the instants (the
 * viewer's local midnights) once; the store only compares.
 *
 * A bucket is a row's local calendar day (`YYYY-MM-DD`) or hour
 * (`YYYY-MM-DDTHH`) in the viewer's IANA zone — `to_char(ts AT TIME ZONE
 * tz, …)` in Postgres, Intl in memory. Both read the same tz database, so
 * they agree for any zone Intl knows.
 */

import { sql, type RawBuilder } from 'kysely';
import type { Bucketing, UsageWindow } from './types';

/** `column` inside the window, for a Kysely `where(...)` or a raw template. */
export function inWindowSql(column: string, window: UsageWindow): RawBuilder<boolean> {
  const ref = sql.ref(column);
  return window.until
    ? sql<boolean>`(${ref} >= ${window.since} AND ${ref} < ${window.until})`
    : sql<boolean>`${ref} >= ${window.since}`;
}

/**
 * The bucket key of `column`. Group by the output alias, never a repeat of
 * this expression: each `${timeZone}` is its own bound parameter, so a
 * repeat is a different expression to Postgres and the query is refused.
 */
export function bucketSql(column: string, bucketing: Bucketing): RawBuilder<string> {
  const pattern = bucketing.granularity === 'hour' ? 'YYYY-MM-DD"T"HH24' : 'YYYY-MM-DD';
  return sql<string>`to_char(${sql.ref(column)} AT TIME ZONE ${bucketing.timeZone}, ${pattern})`;
}

export function inWindow(at: Date, window: UsageWindow): boolean {
  const time = at.getTime();
  return time >= window.since.getTime() && (!window.until || time < window.until.getTime());
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The bucket key of an instant, as `bucketSql` renders it. */
export function bucketOf(at: Date, bucketing: Bucketing): string {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(bucketing.timeZone).formatToParts(at)) {
    parts[part.type] = part.value;
  }
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return bucketing.granularity === 'hour' ? `${day}T${parts.hour}` : day;
}

/** `percentile_disc(fraction) WITHIN GROUP (ORDER BY value)`: null over no rows. */
export function percentileDisc(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(position, sorted.length) - 1];
}

/** SUM over int columns as a number; 0 over no rows (COALESCE(SUM(…), 0)). */
export function sum<T>(rows: readonly T[], value: (row: T) => number | string | null): number {
  return rows.reduce((total, row) => total + Number(value(row) ?? 0), 0);
}
