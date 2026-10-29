/**
 * The memory side's calendar arithmetic, matching ./span.ts: a timestamp's
 * wall-clock parts in a zone (`AT TIME ZONE`), and a local midnight back to
 * an instant. Intl and Postgres read the same IANA rules. One documented
 * difference: a local midnight that does not exist (a DST change at
 * midnight) resolves by the offset before the change here; the scenarios
 * do not use such zones.
 */

import type { UsageGranularity, UsageWindow } from './types';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallClock(at: Date, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const w = wallClock(new Date(at), timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant of local midnight on a calendar date (days may overflow, as Date.UTC allows). */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

function localMidnightBack(back: number, timeZone: string, now: Date): number {
  const today = wallClock(now, timeZone);
  return localMidnight(today.year, today.month, today.day - back, timeZone);
}

/** The window's bounds as instants: [start, end), end null when open. */
export function windowBounds(
  { span, timeZone }: UsageWindow,
  now: Date = new Date()
): { start: number; end: number | null } {
  const back = Math.max(0, span.endOffsetDays + span.days - 1);
  return {
    start: localMidnightBack(back, timeZone, now),
    end: span.endOffsetDays <= 0 ? null : localMidnightBack(span.endOffsetDays - 1, timeZone, now),
  };
}

/** A predicate for "this timestamp is inside the window", bounds fixed once. */
export function inWindow(window: UsageWindow): (at: Date) => boolean {
  const { start, end } = windowBounds(window);
  return (at) => {
    const t = at.getTime();
    return t >= start && (end === null || t < end);
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `to_char(at AT TIME ZONE zone, 'YYYY-MM-DD')`, or with `"T"HH24` for hours. */
export function bucketKey(at: Date, timeZone: string, granularity: UsageGranularity): string {
  const w = wallClock(at, timeZone);
  const day = `${String(w.year).padStart(4, '0')}-${pad(w.month)}-${pad(w.day)}`;
  return granularity === 'hour' ? `${day}T${pad(w.hour)}` : day;
}
