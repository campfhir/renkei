/**
 * When a schedule trigger fires next — pure math, no cron syntax.
 *
 * The builder offers presets (every hour / day / week / month), stored as a
 * structured object rather than a cron string: users never see cron, the
 * validator can check fields instead of parsing a language, and a `cron`
 * variant can join the union later behind this same function.
 *
 * Timezone handling uses Intl only (no date library, per the repo's
 * zero-dependency bias). The wall-clock → instant conversion iterates on
 * the zone's offset, which converges in one step everywhere except within
 * an hour of a DST transition and in two steps there. A local time that
 * does not exist (spring-forward gap) resolves to the shifted instant an
 * hour later; a repeated one (fall-back) resolves to the earlier pass —
 * both are the least surprising available answer for "run at 02:30".
 *
 * `day` for monthly is capped at 28 by the type, so "the 30th" in February
 * is not a case this code can be handed.
 */

export type Recurrence =
  | { every: 'hour' }
  | { every: 'day'; at: string }
  | { every: 'week'; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; at: string }
  | { every: 'month'; day: number; at: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isRecurrence(value: unknown): value is Recurrence {
  if (typeof value !== 'object' || value === null) return false;
  const rec: { every?: unknown; at?: unknown; weekday?: unknown; day?: unknown } = value;
  switch (rec.every) {
    case 'hour':
      return true;
    case 'day':
      return typeof rec.at === 'string' && TIME_PATTERN.test(rec.at);
    case 'week':
      return (
        typeof rec.at === 'string' &&
        TIME_PATTERN.test(rec.at) &&
        typeof rec.weekday === 'number' &&
        Number.isInteger(rec.weekday) &&
        rec.weekday >= 0 &&
        rec.weekday <= 6
      );
    case 'month':
      return (
        typeof rec.at === 'string' &&
        TIME_PATTERN.test(rec.at) &&
        typeof rec.day === 'number' &&
        Number.isInteger(rec.day) &&
        rec.day >= 1 &&
        rec.day <= 28
      );
    default:
      return false;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 (Sunday) - 6
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall clock in `timezone` at a given instant. */
function wallClockAt(instant: Date, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Intl renders midnight as '24' under hour12:false in some engines.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(get('weekday'))),
  };
}

/** Minutes east of UTC in `timezone` at a given instant. */
function offsetMinutes(instant: Date, timezone: string): number {
  const wall = wallClockAt(instant, timezone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The instant at which `timezone`'s wall clock reads the given values. */
function instantOfWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // First guess assumes the offset at the target equals the offset at the
  // naive instant; the refinement corrects it across a transition.
  const guess = asUtc - offsetMinutes(new Date(asUtc), timezone) * 60_000;
  const refined = asUtc - offsetMinutes(new Date(guess), timezone) * 60_000;
  // A wall time inside a spring-forward gap never round-trips — the two
  // guesses oscillate an hour apart forever. Detect it by reading the
  // refined instant back: on a mismatch, take the earlier guess, which
  // renders as the time shifted FORWARD past the gap (02:30 → 03:30), the
  // convention date libraries settled on.
  const wall = wallClockAt(new Date(refined), timezone);
  if (wall.hour === hour && wall.minute === minute) return new Date(refined);
  return new Date(guess);
}

function parseTime(at: string): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(at);
  if (!match) throw new Error(`invalid time: ${at}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The first firing strictly after `from`.
 *
 * Daily/weekly/monthly walk forward one calendar day at a time (bounded —
 * at most ~35 iterations for monthly) building each candidate in the
 * schedule's own timezone, so a DST shift moves the instant, never the
 * wall-clock time the user asked for.
 */
export function computeNextRun(recurrence: Recurrence, timezone: string, from: Date): Date {
  if (recurrence.every === 'hour') {
    // Top of the next hour, timezone-independent.
    const next = new Date(from.getTime());
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }

  const { hour, minute } = parseTime(recurrence.at);
  // Candidate days start on `from`'s own date in the target zone.
  const start = wallClockAt(from, timezone);
  for (let offset = 0; offset < 62; offset += 1) {
    // Date.UTC normalizes day overflow, giving us calendar-correct walks.
    const dayCursor = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = dayCursor.getUTCFullYear();
    const month = dayCursor.getUTCMonth() + 1;
    const day = dayCursor.getUTCDate();

    if (recurrence.every === 'week') {
      const weekday = dayCursor.getUTCDay();
      if (weekday !== recurrence.weekday) continue;
    }
    if (recurrence.every === 'month' && day !== recurrence.day) continue;

    const candidate = instantOfWallClock(year, month, day, hour, minute, timezone);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  // Unreachable for the recurrences the type admits; loud beats silent.
  throw new Error('no next run found within 62 days');
}
