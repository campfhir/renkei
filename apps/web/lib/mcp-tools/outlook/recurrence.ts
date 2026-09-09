/**
 * Recurrence for outlook_create_event: the shared repeat vocabulary
 * (../recurrence.ts) mapped onto Graph's patternedRecurrence — six pattern
 * types where a person thinks in four, an index for "second Tuesday", and
 * a range that must start on the event's own date.
 */

import {
  WEEKDAYS,
  WEEK_OF_MONTH,
  dateOf,
  describeRecurrence,
  parseRecurrenceInput,
  recurrenceFieldSchema as sharedRecurrenceField,
  type RecurrenceInput,
  type Weekday,
  type WeekOfMonth,
} from '../recurrence';

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
    index?: WeekOfMonth;
  };
  range: {
    type: 'noEnd' | 'endDate' | 'numbered';
    startDate: string;
    endDate?: string;
    numberOfOccurrences?: number;
    recurrenceTimeZone?: string;
  };
}

export interface OutlookRecurrence {
  /** What Graph is sent. */
  recurrence: GraphRecurrence;
  /** The series in a person's words, for the reply. */
  description: string;
}

export type RecurrenceResult =
  { ok: true; val: OutlookRecurrence | null } | { ok: false; error: string };

/** The tool's `recurrence` input — for the schema the model sees. */
export const recurrenceFieldSchema = sharedRecurrenceField({
  frequencies: ['daily', 'weekly', 'monthly', 'yearly'],
});

function patternOf(input: RecurrenceInput): GraphRecurrence['pattern'] {
  const { interval } = input;
  switch (input.frequency) {
    case 'daily':
      return { type: 'daily', interval };
    case 'weekly':
      return { type: 'weekly', interval, daysOfWeek: input.daysOfWeek ?? [] };
    case 'monthly':
      return input.weekOfMonth
        ? {
            type: 'relativeMonthly',
            interval,
            daysOfWeek: input.daysOfWeek ?? [],
            index: input.weekOfMonth,
          }
        : { type: 'absoluteMonthly', interval, dayOfMonth: input.dayOfMonth ?? 1 };
    case 'yearly':
      return input.weekOfMonth
        ? {
            type: 'relativeYearly',
            interval,
            daysOfWeek: input.daysOfWeek ?? [],
            index: input.weekOfMonth,
            month: input.month ?? 1,
          }
        : {
            type: 'absoluteYearly',
            interval,
            dayOfMonth: input.dayOfMonth ?? 1,
            month: input.month ?? 1,
          };
  }
}

/**
 * Graph's recurrence for the tool's `recurrence` argument, null when none
 * was given, or the complaint to hand back. `start` is the event's start
 * as the tool received it; the series begins on its date.
 */
export function parseRecurrence(value: unknown, start: string, timezone: string): RecurrenceResult {
  const parsed = parseRecurrenceInput(value, start);
  if (!parsed.ok) return parsed;
  if (!parsed.val) return { ok: true, val: null };
  const input = parsed.val;
  const startDate = input.startDate.text;
  const range: GraphRecurrence['range'] = input.until
    ? { type: 'endDate', startDate, endDate: input.until }
    : input.occurrences
      ? { type: 'numbered', startDate, numberOfOccurrences: input.occurrences }
      : { type: 'noEnd', startDate };
  if (timezone) range.recurrenceTimeZone = timezone;
  return {
    ok: true,
    val: {
      recurrence: { pattern: patternOf(input), range },
      description: describeRecurrence(input),
    },
  };
}

function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function weekdays(value: unknown): Weekday[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const day = WEEKDAYS.find((name) => name === String(entry).toLowerCase());
        return day ? [day] : [];
      })
    : [];
}

function weekOfMonth(value: unknown): WeekOfMonth {
  return WEEK_OF_MONTH.find((name) => name === String(value).toLowerCase()) ?? 'first';
}

/**
 * A series as Graph returns it (an event's `recurrence`), in a person's
 * words — for outlook_get_event and the update tool's reply. Null for an
 * event that does not repeat or a shape this cannot read.
 */
export function describeGraphRecurrence(value: unknown): string | null {
  const pattern = rec(rec(value).pattern);
  const range = rec(rec(value).range);
  const interval =
    typeof pattern.interval === 'number' && pattern.interval > 0 ? pattern.interval : 1;
  const startDate = dateOf(String(range.startDate ?? '')) ?? {
    text: '',
    year: 1,
    month: 1,
    day: 1,
  };
  const end =
    range.type === 'endDate' && typeof range.endDate === 'string'
      ? { until: range.endDate.slice(0, 10) }
      : range.type === 'numbered' && typeof range.numberOfOccurrences === 'number'
        ? { occurrences: range.numberOfOccurrences }
        : {};
  const dayOfMonth = typeof pattern.dayOfMonth === 'number' ? pattern.dayOfMonth : 1;
  const month = typeof pattern.month === 'number' ? pattern.month : 1;
  let input: RecurrenceInput;
  switch (pattern.type) {
    case 'daily':
      input = { frequency: 'daily', interval, ...end, startDate };
      break;
    case 'weekly':
      input = {
        frequency: 'weekly',
        interval,
        daysOfWeek: weekdays(pattern.daysOfWeek),
        ...end,
        startDate,
      };
      break;
    case 'absoluteMonthly':
      input = { frequency: 'monthly', interval, dayOfMonth, ...end, startDate };
      break;
    case 'relativeMonthly':
      input = {
        frequency: 'monthly',
        interval,
        weekOfMonth: weekOfMonth(pattern.index),
        daysOfWeek: weekdays(pattern.daysOfWeek),
        ...end,
        startDate,
      };
      break;
    case 'absoluteYearly':
      input = { frequency: 'yearly', interval, dayOfMonth, month, ...end, startDate };
      break;
    case 'relativeYearly':
      input = {
        frequency: 'yearly',
        interval,
        weekOfMonth: weekOfMonth(pattern.index),
        daysOfWeek: weekdays(pattern.daysOfWeek),
        month,
        ...end,
        startDate,
      };
      break;
    default:
      return null;
  }
  return describeRecurrence(input);
}
