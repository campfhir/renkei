/**
 * Deterministic date arithmetic for agent steps.
 *
 * Models are unreliable at exactly this: "yesterday at 19:00 in
 * America/Los_Angeles, as UTC" asks for a calendar shift, a wall-clock set,
 * and a DST-correct zone conversion, and a wrong answer looks perfectly
 * plausible — an email search then silently covers the wrong window and
 * nobody notices until the results are strange. So the model is not asked
 * to compute a timestamp. It states its INTENT structurally (which zone,
 * which shift, which time of day) and this computes the instant.
 *
 * The zone math is deliberately not reimplemented here: `wallClockAt` and
 * `instantOfWallClock` come from recurrence.ts, which schedules already
 * depend on and which handles the awkward parts (offset refinement across a
 * transition, spring-forward gaps that never round-trip).
 *
 * ORDER OF OPERATIONS, fixed so the same request always means the same
 * thing:
 *   1. `anchor` — 'now', or an explicit ISO instant.
 *   2. `amount` + `unit` — one signed step. Days and larger move the WALL
 *      CLOCK in the target zone, so "yesterday" stays the same time of day
 *      across a DST change; minutes and hours are exact elapsed time.
 *   3. `atTime` — set the wall clock to HH:MM in the target zone.
 *   4. `startOf` / `endOf` — snap to the boundary, when no atTime was given.
 */

import { isValidTimezone, wallClockAt, instantOfWallClock } from './recurrence';

/** How far to move, in units a person would say out loud. */
export type TimeUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export const TIME_UNITS: readonly TimeUnit[] = ['minute', 'hour', 'day', 'week', 'month', 'year'];

export interface ResolveTimeRequest {
  /** IANA zone every wall-clock field is read and written in. */
  timezone: string;
  /** 'now' (default) or an ISO 8601 instant to measure from. */
  anchor?: string;
  /** Signed: -1 with unit 'day' is yesterday, 2 with 'week' is a fortnight out. */
  amount?: number;
  unit?: TimeUnit;
  /** 'HH:MM' — the wall-clock time of day in `timezone`, after shifting. */
  atTime?: string;
  /** Snap to the start of the unit; ignored when `atTime` is given. */
  startOf?: 'hour' | 'day' | 'week' | 'month';
  /** Snap to the last instant of the unit; ignored when `atTime` is given. */
  endOf?: 'hour' | 'day' | 'week' | 'month';
}

export interface ResolvedTime {
  /** The instant, UTC, ISO 8601 — what a tool call should actually use. */
  iso: string;
  epochMs: number;
  /** How that instant reads on the wall clock in `timezone`. */
  local: string;
  timezone: string;
  /** Minutes east of UTC at that instant, e.g. -420 for PDT. */
  offsetMinutes: number;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Bounds on a shift, so a typo cannot ask for the year 400,000. */
const MAX_UNITS = 10_000;

function clampUnit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.trunc(Math.min(MAX_UNITS, Math.max(-MAX_UNITS, value)));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * The computed instant, or a message naming what was wrong with the
 * request. Never throws: the caller hands the message straight back to the
 * model, which is expected to correct itself and call again (this tool is
 * free, so a correction costs nothing but a turn).
 */
export function resolveTime(
  request: ResolveTimeRequest,
  now: Date = new Date()
): { ok: true; value: ResolvedTime } | { ok: false; error: string } {
  const timezone = request.timezone?.trim();
  if (!timezone || !isValidTimezone(timezone)) {
    return {
      ok: false,
      error: `"${request.timezone ?? ''}" is not a recognized IANA timezone (e.g. America/Los_Angeles, UTC).`,
    };
  }

  let anchor: Date;
  if (request.anchor === undefined || request.anchor === 'now' || request.anchor === '') {
    anchor = now;
  } else {
    anchor = new Date(request.anchor);
    if (Number.isNaN(anchor.getTime())) {
      return { ok: false, error: `"${request.anchor}" is not an ISO 8601 instant or "now".` };
    }
  }

  if (request.atTime !== undefined && !TIME_OF_DAY.test(request.atTime)) {
    return { ok: false, error: `"${request.atTime}" is not a 24-hour time of day like "19:00".` };
  }

  const unit = request.unit;
  if (unit !== undefined && !TIME_UNITS.includes(unit)) {
    return {
      ok: false,
      error: `"${String(unit)}" is not a unit — use ${TIME_UNITS.join(', ')}.`,
    };
  }
  if (request.amount !== undefined && unit === undefined) {
    return { ok: false, error: 'An amount needs a unit (e.g. amount: -1, unit: "day").' };
  }
  const amount = unit === undefined ? 0 : clampUnit(request.amount);

  // Minutes and hours are EXACT elapsed time; days and larger move the WALL
  // CLOCK, so "1 day ago" is the same time yesterday even when a DST change
  // makes that 23 or 25 actual hours. Conflating the two is the classic way
  // date arithmetic goes an hour wrong twice a year.
  const elapsed = unit === 'minute' ? amount * 60_000 : unit === 'hour' ? amount * 3_600_000 : 0;
  let wall = wallClockAt(new Date(anchor.getTime() + elapsed), timezone);

  const months = unit === 'month' ? amount : unit === 'year' ? amount * 12 : 0;
  const days = unit === 'day' ? amount : unit === 'week' ? amount * 7 : 0;
  if (months !== 0) {
    const total = wall.year * 12 + (wall.month - 1) + months;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    // "Jan 31 + 1 month" clamps to Feb 28/29 — the calendar convention.
    wall = { ...wall, year, month, day: Math.min(wall.day, daysInMonth(year, month)) };
  }
  if (days !== 0) {
    const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
    wall = {
      ...wall,
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      weekday: shifted.getUTCDay(),
    };
  }

  let { hour, minute } = wall;
  if (request.atTime) {
    const match = TIME_OF_DAY.exec(request.atTime);
    hour = Number(match?.[1] ?? 0);
    minute = Number(match?.[2] ?? 0);
  } else if (request.startOf || request.endOf) {
    const unit = request.startOf ?? request.endOf;
    const toStart = Boolean(request.startOf);
    if (unit === 'hour') {
      minute = toStart ? 0 : 59;
    } else if (unit === 'day') {
      hour = toStart ? 0 : 23;
      minute = toStart ? 0 : 59;
    } else if (unit === 'week') {
      // Weeks start Sunday, matching Recurrence's weekday numbering.
      const weekdayNow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
      const delta = toStart ? -weekdayNow : 6 - weekdayNow;
      const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + delta));
      wall = {
        ...wall,
        year: moved.getUTCFullYear(),
        month: moved.getUTCMonth() + 1,
        day: moved.getUTCDate(),
      };
      hour = toStart ? 0 : 23;
      minute = toStart ? 0 : 59;
    } else if (unit === 'month') {
      wall = { ...wall, day: toStart ? 1 : daysInMonth(wall.year, wall.month) };
      hour = toStart ? 0 : 23;
      minute = toStart ? 0 : 59;
    }
  }

  const instant = instantOfWallClock(wall.year, wall.month, wall.day, hour, minute, timezone);
  const readBack = wallClockAt(instant, timezone);
  const asUtc = Date.UTC(
    readBack.year,
    readBack.month - 1,
    readBack.day,
    readBack.hour,
    readBack.minute
  );
  const offsetMinutes = Math.round((asUtc - instant.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);

  return {
    ok: true,
    value: {
      iso: instant.toISOString(),
      epochMs: instant.getTime(),
      local:
        `${readBack.year}-${pad(readBack.month)}-${pad(readBack.day)} ` +
        `${pad(readBack.hour)}:${pad(readBack.minute)} ` +
        `(UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)})`,
      timezone,
      offsetMinutes,
    },
  };
}

/**
 * A date chip in words, for the builder pill and for previews/history —
 * "yesterday 19:00 America/Los_Angeles". Derived from the parameters rather
 * than stored alongside them, so the label can never drift from what the
 * chip actually resolves to.
 */
export function describeDateSegment(segment: {
  amount: number;
  unit: TimeUnit;
  timezone: string;
  atTime?: string;
  boundary?: 'start' | 'end';
}): string {
  const plural = Math.abs(segment.amount) === 1 ? segment.unit : `${segment.unit}s`;
  const when =
    segment.amount === 0
      ? segment.unit === 'day'
        ? 'today'
        : `this ${segment.unit}`
      : segment.amount === -1 && segment.unit === 'day'
        ? 'yesterday'
        : segment.amount === 1 && segment.unit === 'day'
          ? 'tomorrow'
          : segment.amount < 0
            ? `${Math.abs(segment.amount)} ${plural} ago`
            : `in ${segment.amount} ${plural}`;
  const boundary = segment.atTime
    ? ` ${segment.atTime}`
    : segment.boundary === 'start'
      ? ' (start)'
      : segment.boundary === 'end'
        ? ' (end)'
        : '';
  return `${when}${boundary} ${segment.timezone}`;
}
