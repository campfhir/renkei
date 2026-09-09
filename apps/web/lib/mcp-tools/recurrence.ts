/**
 * A repeat as a person says it — "weekly on Monday and Wednesday, every
 * other week, until June" — for the calendar tools that create a series
 * (outlook_create_event, zoom_create_meeting). One vocabulary, so the
 * model says it the same way whichever calendar it is scheduling on;
 * each connector maps the normalized result onto its own API and limits
 * (outlook/recurrence.ts, zoom/recurrence.ts).
 *
 * Whatever the model leaves unsaid comes from the first occurrence's
 * date: a weekly repeat with no weekdays named falls on the start's
 * weekday, a monthly one on the start's day of month, a yearly one on
 * the start's date — so "every week" is just the frequency. What cannot
 * be derived is reported by field name, so the model's retry is made
 * against the complaint rather than from a guess.
 *
 * The handlers are reached without the schema in tests, and a model that
 * met the field without its schema sends the object as JSON text — so
 * parseRecurrenceInput takes the raw argument and does its own checking,
 * and the zod field only pre-parses that JSON text on its way in.
 */

import { z } from 'zod';

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const WEEK_OF_MONTH = ['first', 'second', 'third', 'fourth', 'last'] as const;
export type WeekOfMonth = (typeof WEEK_OF_MONTH)[number];

/** Sunday first — the index is what both APIs count from. */
export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const MAX_INTERVAL = 999;
export const MAX_OCCURRENCES = 999;

export interface CalendarDate {
  /** YYYY-MM-DD */
  text: string;
  year: number;
  month: number;
  day: number;
}

/** A repeat, checked and with the start's defaults filled in. */
export interface RecurrenceInput {
  frequency: Frequency;
  interval: number;
  /** Weekly: the days. Monthly/yearly: set only for the "nth weekday" form. */
  daysOfWeek?: Weekday[];
  /** Monthly/yearly on a date. */
  dayOfMonth?: number;
  /** Monthly/yearly on a weekday: which week. */
  weekOfMonth?: WeekOfMonth;
  /** Yearly: 1-12. */
  month?: number;
  /** The last date it may fall on, YYYY-MM-DD. */
  until?: string;
  /** Stop after this many. */
  occurrences?: number;
  /** The first occurrence's date. */
  startDate: CalendarDate;
}

export type RecurrenceInputResult =
  { ok: true; val: RecurrenceInput | null } | { ok: false; error: string };

function jsonIfText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The tool's `recurrence` input, for the schema the model sees. Each
 * connector names the frequencies it can repeat at and whether a yearly
 * repeat can name its month.
 */
export function recurrenceFieldSchema(options: {
  frequencies: readonly Frequency[];
  note?: string;
}) {
  const frequencies = options.frequencies.join(', ');
  const units = options.frequencies
    .map((entry) => ({ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' })[entry])
    .join('/');
  const yearly = options.frequencies.includes('yearly');
  return z
    .preprocess(
      jsonIfText,
      z
        .object({
          frequency: z
            .enum(options.frequencies)
            .describe(`How often the event repeats: ${frequencies}`),
          interval: z
            .union([z.number().int().min(1).max(MAX_INTERVAL), z.string()])
            .describe(`Every N ${units} — 1 (the default) is every, 2 every other`)
            .optional(),
          daysOfWeek: z
            .array(z.string())
            .describe(
              'Weekly: the weekdays it falls on, e.g. ["monday", "wednesday"] (default: the ' +
                "start date's weekday). Monthly with weekOfMonth: the weekday, e.g. " +
                '["tuesday"] for "the second Tuesday"'
            )
            .optional(),
          dayOfMonth: z
            .union([z.number().int().min(1).max(31), z.string()])
            .describe("Monthly: the day of the month (default: the start date's day)")
            .optional(),
          weekOfMonth: z
            .enum(WEEK_OF_MONTH)
            .describe(
              'Monthly on a weekday rather than a date: first, second, third, fourth or ' +
                'last, combined with daysOfWeek — "last" + ["friday"] is the last Friday'
            )
            .optional(),
          ...(yearly
            ? {
                month: z
                  .union([z.number().int().min(1).max(12), z.string()])
                  .describe("Yearly: the month, 1-12 (default: the start date's month)")
                  .optional(),
              }
            : {}),
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
      'Repeat it: a series is created rather than a single one. Omit for a one-off. Say the ' +
        'frequency and, when it is not every period on the start date, the interval and the ' +
        'days; an end is optional (until or occurrences).' +
        (options.note ? ` ${options.note}` : '')
    );
}

function fail(error: string): RecurrenceInputResult {
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

/** The calendar date (YYYY-MM-DD) at the front of an ISO-8601 time. */
export function dateOf(start: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(start.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { text: match[0], year, month, day };
}

export function weekdayOfDate(date: CalendarDate): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

function blank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The tool's `recurrence` argument checked and completed from the first
 * occurrence's date; null when none was given; or the complaint to hand
 * back. `start` is the event's start as the tool received it.
 */
export function parseRecurrenceInput(value: unknown, start: string): RecurrenceInputResult {
  const raw = jsonIfText(value);
  if (blank(raw)) return { ok: true, val: null };
  const input = rec(raw);
  if (!input) return fail('recurrence must be an object (frequency, interval, daysOfWeek, …).');

  const frequencyText =
    typeof input.frequency === 'string' ? input.frequency.trim().toLowerCase() : '';
  const frequency = FREQUENCIES.find((entry) => entry === frequencyText);
  if (!frequency) return fail(`recurrence.frequency must be one of ${FREQUENCIES.join(', ')}.`);

  const startDate = dateOf(start);
  if (!startDate) {
    return fail('start must begin with a calendar date (YYYY-MM-DD) for a recurring event.');
  }

  const interval = input.interval === undefined ? 1 : integerOf(input.interval);
  if (interval === null || interval < 1 || interval > MAX_INTERVAL) {
    return fail(`recurrence.interval must be a whole number between 1 and ${MAX_INTERVAL}.`);
  }

  let daysOfWeek: Weekday[] | undefined;
  if (!blank(input.daysOfWeek)) {
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
    const unique = [...new Set(parsed.filter((day): day is Weekday => day !== null))];
    if (unique.length > 0) daysOfWeek = unique;
  }

  let weekOfMonth: WeekOfMonth | undefined;
  if (!blank(input.weekOfMonth)) {
    const text =
      typeof input.weekOfMonth === 'string' ? input.weekOfMonth.trim().toLowerCase() : '';
    weekOfMonth = WEEK_OF_MONTH.find((entry) => entry === text);
    if (!weekOfMonth) {
      return fail(`recurrence.weekOfMonth must be one of ${WEEK_OF_MONTH.join(', ')}.`);
    }
  }

  let dayOfMonth: number | undefined;
  if (!blank(input.dayOfMonth)) {
    const parsed = integerOf(input.dayOfMonth);
    if (parsed === null || parsed < 1 || parsed > 31) {
      return fail('recurrence.dayOfMonth must be a whole number between 1 and 31.');
    }
    dayOfMonth = parsed;
  }

  let month: number | undefined;
  if (!blank(input.month)) {
    const parsed = integerOf(input.month);
    if (parsed === null || parsed < 1 || parsed > 12) {
      return fail('recurrence.month must be a whole number between 1 and 12.');
    }
    month = parsed;
  }

  let until: string | undefined;
  let occurrences: number | undefined;
  if (!blank(input.until)) {
    const parsed = typeof input.until === 'string' ? dateOf(input.until) : null;
    if (!parsed) return fail('recurrence.until must be a date, YYYY-MM-DD.');
    if (parsed.text < startDate.text) {
      return fail('recurrence.until must not be before the start date.');
    }
    until = parsed.text;
  } else if (!blank(input.occurrences)) {
    const parsed = integerOf(input.occurrences);
    if (parsed === null || parsed < 1 || parsed > MAX_OCCURRENCES) {
      return fail(
        `recurrence.occurrences must be a whole number between 1 and ${MAX_OCCURRENCES}.`
      );
    }
    occurrences = parsed;
  }

  const end = { ...(until ? { until } : {}), ...(occurrences ? { occurrences } : {}) };
  switch (frequency) {
    case 'daily':
      return { ok: true, val: { frequency, interval, ...end, startDate } };
    case 'weekly':
      return {
        ok: true,
        val: {
          frequency,
          interval,
          daysOfWeek: daysOfWeek ?? [weekdayOfDate(startDate)],
          ...end,
          startDate,
        },
      };
    case 'monthly':
    case 'yearly': {
      const inMonth = frequency === 'yearly' ? { month: month ?? startDate.month } : {};
      // "The last Friday": a week and a weekday. Weekdays alone mean the first.
      if (weekOfMonth || (daysOfWeek && dayOfMonth === undefined)) {
        if (!daysOfWeek) {
          return fail(
            'recurrence.weekOfMonth needs recurrence.daysOfWeek, the weekday it falls on.'
          );
        }
        return {
          ok: true,
          val: {
            frequency,
            interval,
            daysOfWeek,
            weekOfMonth: weekOfMonth ?? 'first',
            ...inMonth,
            ...end,
            startDate,
          },
        };
      }
      return {
        ok: true,
        val: {
          frequency,
          interval,
          dayOfMonth: dayOfMonth ?? startDate.day,
          ...inMonth,
          ...end,
          startDate,
        },
      };
    }
  }
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
export function describeRecurrence(input: RecurrenceInput): string {
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[input.frequency];
  const every =
    input.interval === 1
      ? `every ${unit}`
      : input.interval === 2
        ? `every other ${unit}`
        : `every ${input.interval} ${unit}s`;
  const days = (input.daysOfWeek ?? []).map(capitalize).join(' and ');
  const monthName = MONTHS[(input.month ?? 1) - 1];
  let when: string;
  switch (input.frequency) {
    case 'daily':
      when = every;
      break;
    case 'weekly':
      when = `${every} on ${days}`;
      break;
    case 'monthly':
      when = input.weekOfMonth
        ? `${every} on the ${input.weekOfMonth} ${days}`
        : `${every} on the ${ordinal(input.dayOfMonth ?? 1)}`;
      break;
    case 'yearly':
      when = input.weekOfMonth
        ? `${every} on the ${input.weekOfMonth} ${days} of ${monthName}`
        : `${every} on ${monthName} ${input.dayOfMonth ?? 1}`;
      break;
  }
  const end = input.until
    ? ` until ${input.until}`
    : input.occurrences
      ? `, ${input.occurrences} times`
      : '';
  return `${when}${end}`;
}
