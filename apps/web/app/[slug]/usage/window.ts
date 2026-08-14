/**
 * The usage page's date arithmetic, kept apart from the server actions so it
 * can be tested without a database — the same split the logs page uses.
 *
 * All of it exists to make a chart honest: the window has to be bounded, the
 * bucket has to be the viewer's day rather than the database's, and a day with
 * no calls has to appear as zero rather than vanish.
 */

export interface UsagePoint {
  /** Day bucket, ISO date. */
  day: string;
  calls: number;
  errors: number;
}

/** Windows outside this range are the caller misreporting, not a request. */
export function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 7;
  return Math.min(Math.max(Math.trunc(days), 1), 90);
}

/**
 * An IANA zone name we are willing to hand to Postgres, or UTC.
 *
 * This reaches `AT TIME ZONE` as a bound parameter, so it cannot inject; the
 * check is for correctness, since Postgres raises on an unknown zone and would
 * turn a bad browser value into a failed page rather than a slightly wrong one.
 */
export function safeTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** Calendar date in a given zone, as YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  // en-CA renders ISO-ordered dates, which is what the SQL side emits too.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Every day in the window, including the ones with no calls.
 *
 * Postgres only returns buckets that have rows, and a chart drawn straight
 * from those would connect Monday to Thursday as though Tuesday and Wednesday
 * never happened — a quiet day has to read as zero, not as absent. Dates are
 * stepped as UTC midnights purely as calendar arithmetic, so a DST boundary
 * cannot drop or duplicate a day.
 */
export function zeroFill(
  rows: UsagePoint[],
  days: number,
  timeZone: string,
  now: Date
): UsagePoint[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const today = localDay(now, timeZone);
  const cursor = new Date(`${today}T00:00:00Z`);
  const filled: UsagePoint[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const at = new Date(cursor);
    at.setUTCDate(at.getUTCDate() - back);
    const day = at.toISOString().slice(0, 10);
    filled.push(found.get(day) ?? { day, calls: 0, errors: 0 });
  }
  return filled;
}
