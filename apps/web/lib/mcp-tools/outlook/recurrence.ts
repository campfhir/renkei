/**
 * Recurrence for outlook_create_event: the shared repeat vocabulary
 * (../recurrence.ts) mapped onto Graph's patternedRecurrence — six pattern
 * types where a person thinks in four, an index for "second Tuesday", and
 * a range that must start on the event's own date.
 */

import {
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
