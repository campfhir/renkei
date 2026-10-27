/**
 * The window predicates and bucket keys, in SQL (the Postgres side) — the
 * memory side's equivalents are in ./zone.ts.
 */

import { sql, type RawBuilder } from 'kysely';
import type { UsageGranularity, UsageWindow } from './types';

/** The span's first instant: local midnight of its oldest day. */
export function spanStart({ span, timeZone }: UsageWindow): RawBuilder<Date> {
  const back = Math.max(0, span.endOffsetDays + span.days - 1);
  return sql<Date>`((date_trunc('day', NOW() AT TIME ZONE ${timeZone}) - MAKE_INTERVAL(days => ${back})) AT TIME ZONE ${timeZone})`;
}

/** The span's exclusive end: local midnight after its newest day; null when it runs up to today. */
export function spanEnd({ span, timeZone }: UsageWindow): RawBuilder<Date> | null {
  if (span.endOffsetDays <= 0) return null;
  const back = span.endOffsetDays - 1;
  return sql<Date>`((date_trunc('day', NOW() AT TIME ZONE ${timeZone}) - MAKE_INTERVAL(days => ${back})) AT TIME ZONE ${timeZone})`;
}

/** `column` falls inside the window. */
export function inSpan(column: string, window: UsageWindow): RawBuilder<boolean> {
  const end = spanEnd(window);
  const ref = sql.ref(column);
  return end === null
    ? sql<boolean>`${ref} >= ${spanStart(window)}`
    : sql<boolean>`(${ref} >= ${spanStart(window)} AND ${ref} < ${end})`;
}

/**
 * A timestamp's bucket key in the viewer's zone. Group by the alias `day`,
 * never by a repeat of the expression: each `${timeZone}` is its own bound
 * parameter, so a repeat is a different expression to Postgres.
 */
export function localBucketOf(
  column: string,
  timeZone: string,
  granularity: UsageGranularity
): RawBuilder<string> {
  return granularity === 'hour'
    ? sql<string>`to_char(${sql.ref(column)} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD"T"HH24')`
    : sql<string>`to_char(${sql.ref(column)} AT TIME ZONE ${timeZone}, 'YYYY-MM-DD')`;
}

export function bucketPattern(granularity: UsageGranularity): string {
  return granularity === 'hour' ? 'YYYY-MM-DD"T"HH24' : 'YYYY-MM-DD';
}

/** `AND <column> = <subject>` when scoped, nothing when org-wide. */
export function ownedBy(column: string, owner: string | null) {
  return owner === null ? sql`` : sql`AND ${sql.ref(column)} = ${owner}`;
}
