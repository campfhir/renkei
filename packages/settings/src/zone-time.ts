/**
 * Wall-clock time in an IANA time zone, for the token limits' resets: an
 * organization says "Monday at 09:00, New York", and the instant that
 * names moves with daylight saving. Pure: Intl's zone data, no clock.
 */

/** Whether `Intl` knows this zone name. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 Sunday … 6 Saturday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The date and time a clock on the wall in `timeZone` shows at `instant`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
  }).formatToParts(instant);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    second: Number(read('second')),
    weekday: Math.max(0, WEEKDAYS.indexOf(read('weekday'))),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const wall = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant a wall clock in `timeZone` shows this date and time. `day`
 * and `month` may run past their ends (day 0, month 13): they carry, as
 * in `Date.UTC`. A time a spring-forward skips lands an hour later; one an
 * autumn fall-back repeats is the first of the two.
 */
export function zonedTime(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The offset at a first guess, then at the instant that guess names: the
  // second pass settles a wall time close to a daylight-saving change.
  const first = wallAsUtc - offsetAt(new Date(wallAsUtc), timeZone);
  return new Date(wallAsUtc - offsetAt(new Date(first), timeZone));
}

/** The zone's short name at `instant`: "UTC", "EST", "GMT+5:30". */
export function zoneAbbreviation(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(instant);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}
