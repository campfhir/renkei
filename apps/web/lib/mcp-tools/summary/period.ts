/**
 * Turning "today" into an instant range.
 *
 * "Today" is not a property of the data — every provider stores UTC — it is a
 * property of the person asking. Someone in Auckland asking at 09:00 local
 * wants a window that started 13 hours before UTC midnight, and computing it
 * in UTC would hand them most of yesterday and none of this morning. So a
 * zone is part of the request, and the resolved bounds carry it so the
 * summary can say which day it actually meant.
 *
 * The zone maths uses Intl rather than a date library: format an instant in
 * the target zone, read it back as if it were UTC, and the difference is that
 * zone's offset at that moment. Applying it twice converges across a DST
 * boundary, where the offset at local midnight differs from the offset now.
 */

import type { SummaryPeriod } from './types';

export const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-14-days',
  'last-30-days',
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** A zone's offset from UTC at a given instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Intl renders midnight as hour 24 in some locales/zones; normalise it.
  const hour = read('hour') % 24;
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second')
  );
  return asIfUtc - instant.getTime();
}

/** Midnight starting the local day that contains `instant`, as a UTC Date. */
function startOfLocalDay(instant: Date, timeZone: string): Date {
  const firstGuess = new Date(instant.getTime() + offsetMs(instant, timeZone));
  firstGuess.setUTCHours(0, 0, 0, 0);
  const candidate = new Date(firstGuess.getTime() - offsetMs(instant, timeZone));
  // Re-resolve using the offset AT that instant: across a DST change the
  // offset now and the offset at local midnight differ by an hour, and using
  // the wrong one puts the boundary in the wrong day.
  const corrected = new Date(firstGuess.getTime() - offsetMs(candidate, timeZone));
  return corrected;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isValidZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export interface PeriodRequest {
  period?: string;
  /** ISO-8601; overrides the preset when both are given. */
  after?: string;
  before?: string;
  /** IANA zone. Defaults to UTC, which is defensible but rarely what a person means. */
  timeZone?: string;
}

/**
 * Resolve a request into concrete bounds. Falls back to today-in-UTC rather
 * than erroring: a summary with a slightly wrong window beats no summary, and
 * the label always states what was used so the model can say so.
 */
export function resolvePeriod(request: PeriodRequest, now: Date = new Date()): SummaryPeriod {
  const timeZone = request.timeZone && isValidZone(request.timeZone) ? request.timeZone : 'UTC';

  // An explicit range wins: someone who names dates means them.
  if (request.after || request.before) {
    const start = request.after ? new Date(request.after) : addDays(now, -7);
    const end = request.before ? new Date(request.before) : now;
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
        timeZone,
      };
    }
  }

  const today = startOfLocalDay(now, timeZone);
  // Matched against the tuple rather than asserted, so an unknown string
  // falls back to today instead of reaching the switch as a lie.
  const preset: PeriodPreset = PERIOD_PRESETS.find((known) => known === request.period) ?? 'today';

  switch (preset) {
    case 'yesterday': {
      const start = addDays(today, -1);
      return { start: start.toISOString(), end: today.toISOString(), label: 'yesterday', timeZone };
    }
    case 'last-7-days':
    case 'last-14-days':
    case 'last-30-days': {
      const days = Number(preset.split('-')[1]);
      const start = addDays(today, -(days - 1));
      return {
        start: start.toISOString(),
        end: addDays(today, 1).toISOString(),
        label: `the last ${days} days`,
        timeZone,
      };
    }
    case 'today':
    default:
      return {
        start: today.toISOString(),
        // End of the local day, not `now`: calendar entries later today are
        // the point of a morning summary, and cutting at the current instant
        // would hide every meeting still to come.
        end: addDays(today, 1).toISOString(),
        label: 'today',
        timeZone,
      };
  }
}
