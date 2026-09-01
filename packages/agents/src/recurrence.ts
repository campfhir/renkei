/**
 * When a schedule trigger fires next — pure math, no cron syntax.
 *
 * The builder offers structured rules (every hour / day / week / month,
 * with the monthly forms below), stored as objects rather than a cron
 * string: users never see cron, the validator can check fields instead of
 * parsing a language, and a `cron` variant can join the union later behind
 * this same function.
 *
 * A schedule (ScheduleConfig) is a LIST of rules combined by union —
 * earliest candidate wins — plus a timezone shared by every rule, an
 * optional start date, and optional BLACKOUTS (per-trigger dates and/or an
 * org holiday calendar, resolved by the caller into a predicate). A rule
 * occurrence landing on a blacked-out date follows the schedule's policy:
 * skipped, or shifted day-by-day (same wall-clock time) to the previous or
 * next clear day. A backward shift that lands in the past degrades to a
 * skip, so `next_run_at` is always strictly in the future.
 *
 * Timezone handling uses Intl only (no date library, per the repo's
 * zero-dependency bias). The wall-clock → instant conversion iterates on
 * the zone's offset, which converges in one step everywhere except within
 * an hour of a DST transition and in two steps there. A local time that
 * does not exist (spring-forward gap) resolves to the shifted instant an
 * hour later; a repeated one (fall-back) resolves to the earlier pass —
 * both are the least surprising available answer for "run at 02:30".
 *
 * Monthly `day` accepts 1–31 and CLAMPS to the month's length ("the 31st"
 * fires Feb 28) — the calendar-app convention; silently skipping short
 * months would produce months with no run.
 *
 * ACTIVE HOURS constrain sub-daily rules (today, only `{every:'hour'}`) to
 * one or more wall-clock windows within the day — "every hour, but only
 * 8am-8pm". Rules with an explicit `at` (day/week/month) already fire once
 * at a chosen time, so active hours do not apply to them: pick an `at`
 * inside the desired range instead. An overnight window is two entries
 * rather than one that wraps midnight (e.g. 00:00-08:00 and 19:00-24:00) —
 * `end` may be "24:00" to mean the end of the day. Empty/absent
 * `activeHours` means unrestricted, so every existing row keeps its exact
 * behavior.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Recurrence =
  | { every: 'hour' }
  | { every: 'day'; at: string }
  | { every: 'weekday'; at: string } // Monday-Friday
  | { every: 'week'; weekday: Weekday; at: string }
  | { every: 'month'; day: number; at: string }
  | { every: 'month'; on: 'last-day' | 'first-weekday' | 'last-weekday'; at: string }
  | { every: 'month'; nth: 1 | 2 | 3 | 4 | -1; weekday: Weekday; at: string };

export const MAX_SCHEDULE_RULES = 5;
export const MAX_SCHEDULE_BLACKOUTS = 20;
export const MAX_ACTIVE_HOURS = 8;

export type BlackoutEntry =
  | { date: string; label?: string } // 'YYYY-MM-DD' one-off
  | { start: string; end: string; label?: string } // inclusive range
  | { annual: string; label?: string }; // 'MM-DD', recurs yearly

export type BlackoutPolicy = 'skip' | 'before' | 'after';

/** A wall-clock window, 'HH:MM'; `end` may be "24:00" for the end of day. */
export interface ActiveHoursWindow {
  start: string;
  end: string;
}

export interface ScheduleConfig {
  /** 1..MAX_SCHEDULE_RULES rules, combined by union (earliest wins). */
  recurrences: Recurrence[];
  /** IANA zone every rule's wall-clock times are read in. */
  timezone: string;
  /** 'YYYY-MM-DD': no occurrence before this date (in `timezone`). */
  startAt?: string;
  /** An org schedule_calendars row to take blackout dates from. */
  calendarId?: string;
  /** Per-trigger blackout dates, on top of the calendar's. */
  blackouts?: BlackoutEntry[];
  /** What happens to an occurrence on a blacked-out date. Default 'after'. */
  blackoutPolicy?: BlackoutPolicy;
  /** Windows (union) sub-daily rules must land in. Up to MAX_ACTIVE_HOURS. */
  activeHours?: ActiveHoursWindow[];
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ANNUAL_PATTERN = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** How far a blackout shift may travel before the rule yields nothing. */
const SHIFT_CAP_DAYS = 30;
/** The natural-occurrence walk bound (worst gap among rule kinds ≈ 35 days). */
const WALK_DAYS = 62;

/** An offending value, rendered compactly for an error message. */
export function shownValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 40 ? `${json.slice(0, 39)}…` : json;
}

/**
 * Why `value` is not a Recurrence, in words the author of the rule can act
 * on, or null when it is one. `isRecurrence` is this function's boolean
 * face, so a verdict and its reason can never drift apart.
 *
 * The messages name the offending key and its accepted values, because the
 * union above is the whole vocabulary: a caller writing a rule by hand
 * (over MCP, say) has no other way to learn that Sunday is `{every:
 * 'week', weekday: 0}` and not `{every: 'sunday'}`.
 */
export function recurrenceIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `a rule must be an object (got ${shownValue(value)})`;
  }
  const rec: {
    every?: unknown;
    at?: unknown;
    weekday?: unknown;
    day?: unknown;
    on?: unknown;
    nth?: unknown;
  } = value;
  const atIssue =
    typeof rec.at === 'string' && TIME_PATTERN.test(rec.at)
      ? null
      : `"at" must be a 24-hour "HH:MM" wall-clock time (got ${shownValue(rec.at)})`;
  const weekdayIssue =
    typeof rec.weekday === 'number' &&
    Number.isInteger(rec.weekday) &&
    rec.weekday >= 0 &&
    rec.weekday <= 6
      ? null
      : `"weekday" must be an integer 0-6, Sunday=0 (got ${shownValue(rec.weekday)})`;
  switch (rec.every) {
    case 'hour':
      return null;
    case 'day':
    case 'weekday':
      return atIssue;
    case 'week':
      return atIssue ?? weekdayIssue;
    case 'month': {
      // Exactly ONE monthly discriminant — jsonb is untyped, and a row
      // carrying two would make the day filter ambiguous.
      const forms = [rec.day !== undefined, rec.on !== undefined, rec.nth !== undefined];
      if (forms.filter(Boolean).length !== 1) {
        return (
          'a monthly rule needs exactly one of "day" (1-31), "on" ("last-day", ' +
          '"first-weekday" or "last-weekday"), or "nth" (1-4, or -1 for last) with "weekday"'
        );
      }
      if (atIssue) return atIssue;
      if (rec.day !== undefined) {
        return typeof rec.day === 'number' &&
          Number.isInteger(rec.day) &&
          rec.day >= 1 &&
          rec.day <= 31
          ? null
          : `"day" must be an integer 1-31 (got ${shownValue(rec.day)})`;
      }
      if (rec.on !== undefined) {
        return rec.on === 'last-day' || rec.on === 'first-weekday' || rec.on === 'last-weekday'
          ? null
          : `"on" must be "last-day", "first-weekday" or "last-weekday" (got ${shownValue(rec.on)})`;
      }
      if (rec.nth !== 1 && rec.nth !== 2 && rec.nth !== 3 && rec.nth !== 4 && rec.nth !== -1) {
        return `"nth" must be 1, 2, 3, 4, or -1 for last (got ${shownValue(rec.nth)})`;
      }
      return weekdayIssue;
    }
    default:
      return `"every" must be "hour", "day", "weekday", "week" or "month" (got ${shownValue(rec.every)})`;
  }
}

export function isRecurrence(value: unknown): value is Recurrence {
  return recurrenceIssue(value) === null;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** A real calendar date in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isValidDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  );
}

export function isBlackoutEntry(value: unknown): value is BlackoutEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry: {
    date?: unknown;
    start?: unknown;
    end?: unknown;
    annual?: unknown;
    label?: unknown;
  } = value;
  if (entry.label !== undefined && typeof entry.label !== 'string') return false;
  if (typeof entry.date === 'string') return isValidDateString(entry.date);
  if (typeof entry.start === 'string' && typeof entry.end === 'string') {
    return (
      isValidDateString(entry.start) && isValidDateString(entry.end) && entry.start <= entry.end
    );
  }
  if (typeof entry.annual === 'string') return ANNUAL_PATTERN.test(entry.annual);
  return false;
}

export function isActiveHoursWindow(value: unknown): value is ActiveHoursWindow {
  if (typeof value !== 'object' || value === null) return false;
  const window: { start?: unknown; end?: unknown } = value;
  if (typeof window.start !== 'string' || !TIME_PATTERN.test(window.start)) return false;
  if (typeof window.end !== 'string' || !END_TIME_PATTERN.test(window.end)) return false;
  return window.start < window.end;
}

/**
 * Does the wall-clock time `hour:minute` fall in one of `windows`? No
 * windows means unrestricted. `end` is exclusive, so a window ending
 * "20:00" covers up to 19:59 and "24:00" covers through 23:59.
 */
function inActiveHours(hour: number, minute: number, windows?: ActiveHoursWindow[]): boolean {
  if (!windows || windows.length === 0) return true;
  const hhmm = `${pad2(hour)}:${pad2(minute)}`;
  return windows.some((window) => window.start <= hhmm && hhmm < window.end);
}

/**
 * Fold blackout entries into one date predicate. Dates are compared as
 * 'YYYY-MM-DD' strings in the SCHEDULE's timezone — ISO dates compare
 * lexicographically, so ranges need no parsing.
 */
export function blackoutPredicate(
  entries: readonly BlackoutEntry[]
): (localDate: string) => boolean {
  if (entries.length === 0) return () => false;
  return (localDate: string) =>
    entries.some((entry) => {
      if ('date' in entry && typeof entry.date === 'string') return entry.date === localDate;
      if ('start' in entry && typeof entry.start === 'string') {
        return entry.start <= localDate && localDate <= entry.end;
      }
      if ('annual' in entry && typeof entry.annual === 'string') {
        return localDate.slice(5) === entry.annual;
      }
      return false;
    });
}

/**
 * Read a stored schedule config (jsonb, so defensively) into the current
 * shape, or null when unusable. The single shared reader for the store,
 * the sweep, and tests.
 *
 * Legacy fallback: rows written before multi-rule carried a single
 * `recurrence` — accepted here as a one-rule list, so a replica sweeping
 * mid-deploy (before migration 042 runs) still fires correctly.
 */
export function parseScheduleConfig(value: unknown): ScheduleConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const config: {
    recurrences?: unknown;
    recurrence?: unknown;
    timezone?: unknown;
    startAt?: unknown;
    calendarId?: unknown;
    blackouts?: unknown;
    blackoutPolicy?: unknown;
    activeHours?: unknown;
  } = value;

  if (typeof config.timezone !== 'string' || !config.timezone) return null;

  let recurrences: Recurrence[];
  if (Array.isArray(config.recurrences)) {
    if (config.recurrences.length === 0 || !config.recurrences.every(isRecurrence)) return null;
    recurrences = config.recurrences;
  } else if (isRecurrence(config.recurrence)) {
    recurrences = [config.recurrence];
  } else {
    return null;
  }

  if (config.startAt !== undefined) {
    if (typeof config.startAt !== 'string' || !isValidDateString(config.startAt)) return null;
  }
  if (config.calendarId !== undefined && typeof config.calendarId !== 'string') return null;
  let blackouts: BlackoutEntry[] | undefined;
  if (config.blackouts !== undefined) {
    if (!Array.isArray(config.blackouts) || !config.blackouts.every(isBlackoutEntry)) return null;
    blackouts = config.blackouts;
  }
  if (
    config.blackoutPolicy !== undefined &&
    config.blackoutPolicy !== 'skip' &&
    config.blackoutPolicy !== 'before' &&
    config.blackoutPolicy !== 'after'
  ) {
    return null;
  }
  let activeHours: ActiveHoursWindow[] | undefined;
  if (config.activeHours !== undefined) {
    if (
      !Array.isArray(config.activeHours) ||
      config.activeHours.length > MAX_ACTIVE_HOURS ||
      !config.activeHours.every(isActiveHoursWindow)
    ) {
      return null;
    }
    activeHours = config.activeHours;
  }

  return {
    recurrences,
    timezone: config.timezone,
    ...(typeof config.startAt === 'string' ? { startAt: config.startAt } : {}),
    ...(typeof config.calendarId === 'string' && config.calendarId
      ? { calendarId: config.calendarId }
      : {}),
    ...(blackouts && blackouts.length > 0 ? { blackouts } : {}),
    ...(config.blackoutPolicy !== undefined ? { blackoutPolicy: config.blackoutPolicy } : {}),
    ...(activeHours && activeHours.length > 0 ? { activeHours } : {}),
  };
}

/**
 * The canonical stored form — fixed key order, no undefined members — so
 * "did the schedule actually change?" is a string comparison.
 */
export function serializeScheduleConfig(config: ScheduleConfig): string {
  return JSON.stringify({
    recurrences: config.recurrences,
    timezone: config.timezone,
    ...(config.startAt ? { startAt: config.startAt } : {}),
    ...(config.calendarId ? { calendarId: config.calendarId } : {}),
    ...(config.blackouts && config.blackouts.length > 0 ? { blackouts: config.blackouts } : {}),
    ...(config.blackoutPolicy ? { blackoutPolicy: config.blackoutPolicy } : {}),
    ...(config.activeHours && config.activeHours.length > 0
      ? { activeHours: config.activeHours }
      : {}),
  });
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 (Sunday) - 6
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall clock in `timezone` at a given instant. */
export function wallClockAt(instant: Date, timezone: string): WallClock {
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
export function instantOfWallClock(
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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateStringOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Does this calendar day satisfy the rule's day filter? */
function matchesRuleDay(recurrence: Recurrence, dayCursor: Date): boolean {
  if (recurrence.every === 'day') return true;
  const weekday = dayCursor.getUTCDay();
  if (recurrence.every === 'weekday') return weekday >= 1 && weekday <= 5;
  if (recurrence.every === 'week') return weekday === recurrence.weekday;
  // 'hour' never reaches the day walk; the narrowing keeps TS honest.
  if (recurrence.every !== 'month') return false;
  // Monthly forms. Day-of-month arithmetic happens in UTC on the cursor,
  // which tracks the ZONE's calendar because the walk starts from the
  // zone's wall clock.
  const day = dayCursor.getUTCDate();
  const lastDay = new Date(
    Date.UTC(dayCursor.getUTCFullYear(), dayCursor.getUTCMonth() + 1, 0)
  ).getUTCDate();
  if ('day' in recurrence) {
    // Clamp: "the 31st" fires on the month's last day when shorter.
    return day === Math.min(recurrence.day, lastDay);
  }
  if ('on' in recurrence) {
    const workday = weekday >= 1 && weekday <= 5;
    switch (recurrence.on) {
      case 'last-day':
        return day === lastDay;
      case 'first-weekday':
        // The first workday: the 1st when it's Mon-Fri, else the following
        // Monday (the 2nd or 3rd).
        return workday && (day === 1 || (weekday === 1 && day <= 3));
      case 'last-weekday':
        return workday && (day === lastDay || (weekday === 5 && day >= lastDay - 2));
    }
  }
  if (weekday !== recurrence.weekday) return false;
  // Nth weekday: week index from the day number; 'last' = within the final
  // seven days of the month.
  return recurrence.nth === -1 ? day > lastDay - 7 : Math.ceil(day / 7) === recurrence.nth;
}

interface RuleOptions {
  isBlackout?: (localDate: string) => boolean;
  policy?: BlackoutPolicy;
  /** Wall-clock windows an 'hour' rule must land in. Ignored by other kinds. */
  activeHours?: ActiveHoursWindow[];
}

/**
 * The first firing of one rule strictly after `from`, or null when the
 * walk (plus blackout handling) finds none. The multi-rule union and the
 * "every rule dry" error live in computeNextRunForSchedule.
 */
function nextRunOfRule(
  recurrence: Recurrence,
  timezone: string,
  from: Date,
  options: RuleOptions = {}
): Date | null {
  const isBlackout = options.isBlackout ?? (() => false);
  const policy = options.policy ?? 'after';

  if (recurrence.every === 'hour') {
    // Top of the next hour, timezone-independent — except that a blackout
    // suppresses the whole local day and active hours suppress hours
    // outside the configured windows, so the next firing is the first hour
    // whose local date is clear AND whose wall-clock time is in-window.
    // Policy is irrelevant: shifting an hourly run is indistinguishable
    // from skipping to the next clear, in-window hour.
    const next = new Date(from.getTime());
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    for (let hops = 0; hops <= (SHIFT_CAP_DAYS + 2) * 24; hops += 1) {
      const wall = wallClockAt(next, timezone);
      const clear = !isBlackout(dateStringOf(wall.year, wall.month, wall.day));
      if (clear && inActiveHours(wall.hour, wall.minute, options.activeHours)) return next;
      next.setUTCHours(next.getUTCHours() + 1);
    }
    return null;
  }

  const { hour, minute } = parseTime(recurrence.at);
  // Candidate days start on `from`'s own date in the target zone.
  const start = wallClockAt(from, timezone);
  for (let offset = 0; offset < WALK_DAYS; offset += 1) {
    // Date.UTC normalizes day overflow, giving us calendar-correct walks.
    const dayCursor = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (!matchesRuleDay(recurrence, dayCursor)) continue;

    const year = dayCursor.getUTCFullYear();
    const month = dayCursor.getUTCMonth() + 1;
    const day = dayCursor.getUTCDate();
    const natural = instantOfWallClock(year, month, day, hour, minute, timezone);
    // An occurrence that already passed is nobody's to shift — keep walking.
    if (natural.getTime() <= from.getTime()) continue;

    if (!isBlackout(dateStringOf(year, month, day))) return natural;

    if (policy === 'skip') continue;
    const step = policy === 'after' ? 1 : -1;
    for (let shift = 1; shift <= SHIFT_CAP_DAYS; shift += 1) {
      const shifted = new Date(Date.UTC(year, month - 1, day + shift * step));
      const sYear = shifted.getUTCFullYear();
      const sMonth = shifted.getUTCMonth() + 1;
      const sDay = shifted.getUTCDate();
      if (isBlackout(dateStringOf(sYear, sMonth, sDay))) continue;
      const candidate = instantOfWallClock(sYear, sMonth, sDay, hour, minute, timezone);
      if (candidate.getTime() > from.getTime()) return candidate;
      // A backward shift that lands in the past means the occurrence
      // effectively already happened — degrade to skip.
      break;
    }
    if (policy === 'after') {
      // No clear day within the cap: the rule is smothered — yield nothing
      // rather than fire mid-blackout.
      return null;
    }
    // 'before' fell through (past, or capped): skip this occurrence.
  }
  return null;
}

/**
 * The first firing of a single rule strictly after `from` — the original
 * entry point, kept for callers that hold one rule (and for the builder's
 * per-rule preview). Throws when the walk finds nothing, which the type
 * cannot produce without blackouts.
 */
export function computeNextRun(recurrence: Recurrence, timezone: string, from: Date): Date {
  const next = nextRunOfRule(recurrence, timezone, from);
  if (!next) throw new Error('no next run found within 62 days');
  return next;
}

/**
 * The first firing of a whole schedule strictly after `from`: the union of
 * its rules (earliest candidate wins), clamped by `startAt`, with blackout
 * dates handled per the schedule's policy.
 *
 * `calendarBlackout` is the resolved org calendar (a database row this
 * pure function must not fetch); the schedule's own `blackouts` are folded
 * in here. Throws when EVERY rule comes up dry — the sweep's
 * disable-with-last_error path reports that plainly.
 */
export function computeNextRunForSchedule(
  config: ScheduleConfig,
  from: Date,
  calendarBlackout?: (localDate: string) => boolean
): Date {
  let effectiveFrom = from;
  if (config.startAt) {
    const [year, month, day] = config.startAt.split('-').map(Number);
    // One ms before the start date's midnight: the first occurrence ON the
    // start date still qualifies as strictly-after.
    const startInstant = new Date(
      instantOfWallClock(year, month, day, 0, 0, config.timezone).getTime() - 1
    );
    if (startInstant.getTime() > from.getTime()) effectiveFrom = startInstant;
  }

  const own = blackoutPredicate(config.blackouts ?? []);
  const isBlackout = calendarBlackout
    ? (localDate: string) => calendarBlackout(localDate) || own(localDate)
    : own;
  const options: RuleOptions = {
    isBlackout,
    policy: config.blackoutPolicy ?? 'after',
    activeHours: config.activeHours,
  };

  let earliest: Date | null = null;
  for (const rule of config.recurrences) {
    const candidate = nextRunOfRule(rule, config.timezone, effectiveFrom, options);
    if (candidate && (!earliest || candidate.getTime() < earliest.getTime())) {
      earliest = candidate;
    }
  }
  if (!earliest) throw new Error('no next run found within 62 days');
  return earliest;
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function ordinal(value: number): string {
  const tail = value % 10;
  const teens = value % 100;
  if (teens >= 11 && teens <= 13) return `${value}th`;
  return `${value}${tail === 1 ? 'st' : tail === 2 ? 'nd' : tail === 3 ? 'rd' : 'th'}`;
}

/** One rule as prose, lowercase so rules can be joined into a sentence. */
export function describeRecurrence(recurrence: Recurrence): string {
  switch (recurrence.every) {
    case 'hour':
      return 'every hour';
    case 'day':
      return `every day at ${recurrence.at}`;
    case 'weekday':
      return `every weekday (Mon–Fri) at ${recurrence.at}`;
    case 'week':
      return `every ${WEEKDAY_NAMES[recurrence.weekday]} at ${recurrence.at}`;
    case 'month': {
      if ('day' in recurrence) {
        return `the ${ordinal(recurrence.day)} of each month at ${recurrence.at}`;
      }
      if ('on' in recurrence) {
        const what =
          recurrence.on === 'last-day'
            ? 'last day'
            : recurrence.on === 'first-weekday'
              ? 'first weekday'
              : 'last weekday';
        return `the ${what} of each month at ${recurrence.at}`;
      }
      const which = recurrence.nth === -1 ? 'last' : ordinal(recurrence.nth);
      return `the ${which} ${WEEKDAY_NAMES[recurrence.weekday]} of each month at ${recurrence.at}`;
    }
  }
}

/**
 * A whole schedule as one sentence — the single humanizer the builder's
 * trigger list, the LLM-facing agent description, and the worker share, so
 * no two surfaces describe the same schedule differently.
 */
export function describeSchedule(config: ScheduleConfig): string {
  const rules = config.recurrences.map(describeRecurrence).join(', and ');
  const sentence = rules.charAt(0).toUpperCase() + rules.slice(1);
  const extras: string[] = [];
  if (config.startAt) extras.push(`starting ${config.startAt}`);
  if (config.calendarId || (config.blackouts && config.blackouts.length > 0)) {
    const policy = config.blackoutPolicy ?? 'after';
    extras.push(
      policy === 'skip'
        ? 'skipping blackout dates'
        : policy === 'before'
          ? 'shifting blackout dates to the previous clear day'
          : 'shifting blackout dates to the next clear day'
    );
  }
  if (config.activeHours && config.activeHours.length > 0) {
    const windows = config.activeHours.map((window) => `${window.start}–${window.end}`).join(', ');
    extras.push(`active ${windows}`);
  }
  return extras.length > 0 ? `${sentence} — ${extras.join(', ')}` : sentence;
}
