/**
 * Recurrence for outlook_create_event: the model's plain description of a
 * repeat ("weekly on Monday and Wednesday, every other week, until June")
 * mapped onto Graph's patternedRecurrence.
 *
 * Graph's own shape is exact but unforgiving — six pattern types where a
 * person thinks in four, an index for "second Tuesday", and a range that
 * must start on the event's own date. The field here asks for what a
 * person would say and derives the rest from the event's start: a weekly
 * repeat with no weekdays named falls on the start's weekday, a monthly
 * one on the start's day of month, a yearly one on the start's date. What
 * cannot be derived is reported by field name, so the model's retry is
 * made against the complaint rather than from a guess.
 *
 * The handler is reached without the schema in tests, and a model that
 * met the field without its schema sends the object as JSON text — so
 * parseRecurrence takes the raw argument and does its own checking, and
 * the zod field only pre-parses that JSON text on its way in.
 */

import { z } from 'zod';

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

const WEEK_OF_MONTH = ['first', 'second', 'third', 'fourth', 'last'] as const;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
type Weekday = (typeof WEEKDAYS)[number];

const MAX_INTERVAL = 999;
const MAX_OCCURRENCES = 999;

export interface GraphRecurrence {
  pattern: {
    type:
      | 'daily'
      | 'weekly'
      | 'absoluteMonthly'
      | 'relativeMonthly'
      | 'absoluteYearly'
      | 'relativeYearly';
    interval: number;
    daysOfWeek?: Weekday[];
    dayOfMonth?: number;
    month?: number;
    index?: (typeof WEEK_OF_MONTH)[number];
  };
  range: {
    type: 'noEnd' | 'endDate' | 'numbered';
    startDate: string;
    endDate?: string;
    numberOfOccurrences?: number;
    recurrenceTimeZone?: string;
  };
}

function jsonIfText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** The tool's `recurrence` input — for the schema the model sees. */
export const recurrenceFieldSchema = z
  .preprocess(
    jsonIfText,
    z
      .object({
        frequency: z
          .enum(FREQUENCIES)
          .describe('How often the event repeats: daily, weekly, monthly or yearly'),
        interval: z
          .union([z.number().int().min(1).max(MAX_INTERVAL), z.string()])
          .describe('Every N days/weeks/months/years — 1 (the default) is every, 2 every other')
          .optional(),
        daysOfWeek: z
          .array(z.string())
          .describe(
            'Weekly: the weekdays it falls on, e.g. ["monday", "wednesday"] (default: the ' +
              "start date's weekday). Monthly/yearly with weekOfMonth: the weekday, e.g. " +
              '["tuesday"] for "the second Tuesday"'
          )
          .optional(),
        dayOfMonth: z
          .union([z.number().int().min(1).max(31), z.string()])
          .describe("Monthly/yearly: the day of the month (default: the start date's day)")
          .optional(),
        weekOfMonth: z
          .enum(WEEK_OF_MONTH)
          .describe(
            'Monthly/yearly on a weekday rather than a date: first, second, third, fourth or ' +
              'last, combined with daysOfWeek — "last" + ["friday"] is the last Friday'
          )
          .optional(),
        month: z
          .union([z.number().int().min(1).max(12), z.string()])
          .describe("Yearly: the month, 1-12 (default: the start date's month)")
          .optional(),
        until: z
          .string()
          .describe('The last date it may fall on, YYYY-MM-DD. Omit for no end date')
          .optional(),
        occurrences: z
          .union([z.number().int().min(1).max(MAX_OCCURRENCES), z.string()])
          .describe('Stop after this many occurrences. Omit for no end date')
          .optional(),
      })
      .optional()
  )
  .describe(
    'Repeat the event: a series is created rather than a single event. Omit for a one-off. ' +
      'Say the frequency and, when it is not every period on the start date, the interval ' +
      'and the days; an end is optional (until or occurrences).'
  );

export type RecurrenceResult =
  { ok: true; val: GraphRecurrence | null } | { ok: false; error: string };

function fail(error: string): RecurrenceResult {
  return { ok: false, error };
}

function rec(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = entry;
  return out;
}

/** A whole number from a number or a numeric string; null when it is neither. */
function integerOf(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function weekdayOf(value: unknown): Weekday | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return WEEKDAYS.find((day) => day === lower || day.slice(0, 3) === lower.slice(0, 3)) ?? null;
}

/** The calendar date (YYYY-MM-DD) at the front of an ISO-8601 local time. */
function dateOf(start: string): { text: string; year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(start.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { text: match[0], year, month, day };
}

function weekdayOfDate(date: { year: number; month: number; day: number }): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

/**
 * Graph's recurrence for the tool's `recurrence` argument, null when none
 * was given, or the complaint to hand back. `start` is the event's start
 * as the tool received it; the series begins on its date.
 */
export function parseRecurrence(value: unknown, start: string, timezone: string): RecurrenceResult {
  const raw = jsonIfText(value);
  if (raw === undefined || raw === null || raw === '') return { ok: true, val: null };
  const input = rec(raw);
  if (!input) return fail('recurrence must be an object (frequency, interval, daysOfWeek, …).');

  const frequencyText =
    typeof input.frequency === 'string' ? input.frequency.trim().toLowerCase() : '';
  const frequency = FREQUENCIES.find((entry) => entry === frequencyText);
  if (!frequency) {
    return fail(`recurrence.frequency must be one of ${FREQUENCIES.join(', ')}.`);
  }

  const startDate = dateOf(start);
  if (!startDate)
    return fail('start must begin with a calendar date (YYYY-MM-DD) for a recurring event.');

  const interval = input.interval === undefined ? 1 : integerOf(input.interval);
  if (interval === null || interval < 1 || interval > MAX_INTERVAL) {
    return fail(`recurrence.interval must be a whole number between 1 and ${MAX_INTERVAL}.`);
  }

  let daysOfWeek: Weekday[] | undefined;
  if (input.daysOfWeek !== undefined) {
    const list = Array.isArray(input.daysOfWeek)
      ? input.daysOfWeek
      : typeof input.daysOfWeek === 'string'
        ? input.daysOfWeek.split(',')
        : null;
    if (!list) return fail('recurrence.daysOfWeek must be a list of weekday names.');
    const parsed = list.map(weekdayOf);
    if (parsed.some((day) => day === null)) {
      return fail(`recurrence.daysOfWeek must name weekdays (${WEEKDAYS.join(', ')}).`);
    }
    daysOfWeek = [...new Set(parsed.filter((day): day is Weekday => day !== null))];
    if (daysOfWeek.length === 0) daysOfWeek = undefined;
  }

  const weekOfMonth =
    input.weekOfMonth === undefined
      ? undefined
      : WEEK_OF_MONTH.find(
          (entry) =>
            typeof input.weekOfMonth === 'string' &&
            entry === input.weekOfMonth.trim().toLowerCase()
        );
  if (input.weekOfMonth !== undefined && !weekOfMonth) {
    return fail(`recurrence.weekOfMonth must be one of ${WEEK_OF_MONTH.join(', ')}.`);
  }

  const dayOfMonth = input.dayOfMonth === undefined ? undefined : integerOf(input.dayOfMonth);
  if (dayOfMonth === null || (dayOfMonth !== undefined && (dayOfMonth < 1 || dayOfMonth > 31))) {
    return fail('recurrence.dayOfMonth must be a whole number between 1 and 31.');
  }

  const month = input.month === undefined ? undefined : integerOf(input.month);
  if (month === null || (month !== undefined && (month < 1 || month > 12))) {
    return fail('recurrence.month must be a whole number between 1 and 12.');
  }

  let pattern: GraphRecurrence['pattern'];
  switch (frequency) {
    case 'daily':
      pattern = { type: 'daily', interval };
      break;
    case 'weekly':
      pattern = { type: 'weekly', interval, daysOfWeek: daysOfWeek ?? [weekdayOfDate(startDate)] };
      break;
    case 'monthly':
      if (weekOfMonth || (daysOfWeek && dayOfMonth === undefined)) {
        if (!daysOfWeek) {
          return fail(
            'recurrence.weekOfMonth needs recurrence.daysOfWeek, the weekday it falls on.'
          );
        }
        pattern = { type: 'relativeMonthly', interval, daysOfWeek, index: weekOfMonth ?? 'first' };
      } else {
        pattern = { type: 'absoluteMonthly', interval, dayOfMonth: dayOfMonth ?? startDate.day };
      }
      break;
    case 'yearly':
      if (weekOfMonth || (daysOfWeek && dayOfMonth === undefined)) {
        if (!daysOfWeek) {
          return fail(
            'recurrence.weekOfMonth needs recurrence.daysOfWeek, the weekday it falls on.'
          );
        }
        pattern = {
          type: 'relativeYearly',
          interval,
          daysOfWeek,
          index: weekOfMonth ?? 'first',
          month: month ?? startDate.month,
        };
      } else {
        pattern = {
          type: 'absoluteYearly',
          interval,
          dayOfMonth: dayOfMonth ?? startDate.day,
          month: month ?? startDate.month,
        };
      }
      break;
  }

  let range: GraphRecurrence['range'] = { type: 'noEnd', startDate: startDate.text };
  if (input.until !== undefined && input.until !== null && input.until !== '') {
    const until = typeof input.until === 'string' ? dateOf(input.until) : null;
    if (!until) return fail('recurrence.until must be a date, YYYY-MM-DD.');
    if (until.text < startDate.text)
      return fail('recurrence.until must not be before the start date.');
    range = { type: 'endDate', startDate: startDate.text, endDate: until.text };
  } else if (
    input.occurrences !== undefined &&
    input.occurrences !== null &&
    input.occurrences !== ''
  ) {
    const occurrences = integerOf(input.occurrences);
    if (occurrences === null || occurrences < 1 || occurrences > MAX_OCCURRENCES) {
      return fail(
        `recurrence.occurrences must be a whole number between 1 and ${MAX_OCCURRENCES}.`
      );
    }
    range = { type: 'numbered', startDate: startDate.text, numberOfOccurrences: occurrences };
  }
  if (timezone) range.recurrenceTimeZone = timezone;

  return { ok: true, val: { pattern, range } };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ordinal(day: number): string {
  const rest = day % 100;
  const suffix =
    rest >= 11 && rest <= 13
      ? 'th'
      : day % 10 === 1
        ? 'st'
        : day % 10 === 2
          ? 'nd'
          : day % 10 === 3
            ? 'rd'
            : 'th';
  return `${day}${suffix}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The series in a person's words — "every other week on Monday and Wednesday until 2026-12-18". */
export function describeRecurrence(recurrence: GraphRecurrence): string {
  const { pattern, range } = recurrence;
  const unit = {
    daily: 'day',
    weekly: 'week',
    absoluteMonthly: 'month',
    relativeMonthly: 'month',
    absoluteYearly: 'year',
    relativeYearly: 'year',
  }[pattern.type];
  const every =
    pattern.interval === 1
      ? `every ${unit}`
      : pattern.interval === 2
        ? `every other ${unit}`
        : `every ${pattern.interval} ${unit}s`;
  const days = (pattern.daysOfWeek ?? []).map(capitalize).join(' and ');
  let when: string;
  switch (pattern.type) {
    case 'daily':
      when = every;
      break;
    case 'weekly':
      when = `${every} on ${days}`;
      break;
    case 'absoluteMonthly':
      when = `${every} on the ${ordinal(pattern.dayOfMonth ?? 1)}`;
      break;
    case 'relativeMonthly':
      when = `${every} on the ${pattern.index ?? 'first'} ${days}`;
      break;
    case 'absoluteYearly':
      when = `${every} on ${MONTHS[(pattern.month ?? 1) - 1]} ${pattern.dayOfMonth ?? 1}`;
      break;
    case 'relativeYearly':
      when = `${every} on the ${pattern.index ?? 'first'} ${days} of ${MONTHS[(pattern.month ?? 1) - 1]}`;
      break;
  }
  const end =
    range.type === 'endDate'
      ? ` until ${range.endDate}`
      : range.type === 'numbered'
        ? `, ${range.numberOfOccurrences} times`
        : '';
  return `${when}${end}`;
}
