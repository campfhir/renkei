/**
 * Recurrence for zoom_create_meeting: the shared repeat vocabulary
 * (../recurrence.ts) mapped onto Zoom's recurrence object for a meeting
 * of type 8 (recurring, fixed time). Zoom is the narrower calendar: it
 * repeats daily, weekly or monthly (never yearly), on ONE weekday for a
 * monthly "nth weekday", and caps the interval per frequency — each of
 * which is refused here by name rather than left to Zoom's own message.
 */

import {
  WEEKDAYS,
  describeRecurrence,
  parseRecurrenceInput,
  recurrenceFieldSchema,
  type RecurrenceInput,
} from '../recurrence';

export const ZOOM_RECURRING_MEETING_TYPE = 8;

/** Zoom's documented maximum repeat_interval per frequency. */
const MAX_INTERVAL = { daily: 90, weekly: 12, monthly: 3 } as const;
const UNITS = { daily: 'days', weekly: 'weeks', monthly: 'months' } as const;

export interface ZoomRecurrence {
  /** 1 daily, 2 weekly, 3 monthly. */
  type: 1 | 2 | 3;
  repeat_interval: number;
  /** Weekly: "1,3,5" — Zoom counts Sunday as 1. */
  weekly_days?: string;
  monthly_day?: number;
  /** -1 last, 1-4. */
  monthly_week?: -1 | 1 | 2 | 3 | 4;
  monthly_week_day?: number;
  end_times?: number;
  /** UTC, yyyy-MM-ddTHH:mm:ssZ. */
  end_date_time?: string;
}

export interface ZoomRecurrenceValue {
  /** What Zoom is sent. */
  recurrence: ZoomRecurrence;
  /** The series in a person's words, for the reply and the preview card. */
  description: string;
  /** The checked input, as the preview card hands it on to confirm. */
  input: Omit<RecurrenceInput, 'startDate'>;
}

export type ZoomRecurrenceResult =
  { ok: true; val: ZoomRecurrenceValue | null } | { ok: false; error: string };

/** The tool's `recurrence` input — for the schema the model sees. */
export const zoomRecurrenceFieldSchema = recurrenceFieldSchema({
  frequencies: ['daily', 'weekly', 'monthly'],
  note: 'Zoom repeats at most every 90 days, 12 weeks or 3 months.',
});

const WEEK_INDEX = { first: 1, second: 2, third: 3, fourth: 4, last: -1 } as const;

function fail(error: string): ZoomRecurrenceResult {
  return { ok: false, error };
}

/**
 * Zoom's recurrence for the tool's `recurrence` argument, null when none
 * was given, or the complaint to hand back. `start` is the meeting's
 * start as the tool received it; the series begins on its date.
 */
export function parseZoomRecurrence(value: unknown, start: string): ZoomRecurrenceResult {
  const parsed = parseRecurrenceInput(value, start);
  if (!parsed.ok) return parsed;
  if (!parsed.val) return { ok: true, val: null };
  const input = parsed.val;
  if (input.frequency === 'yearly') {
    return fail('recurrence.frequency: Zoom meetings repeat daily, weekly or monthly, not yearly.');
  }
  const maxInterval = MAX_INTERVAL[input.frequency];
  if (input.interval > maxInterval) {
    return fail(
      `recurrence.interval: Zoom repeats a ${input.frequency} meeting at most every ${maxInterval} ${UNITS[input.frequency]}.`
    );
  }

  let recurrence: ZoomRecurrence;
  switch (input.frequency) {
    case 'daily':
      recurrence = { type: 1, repeat_interval: input.interval };
      break;
    case 'weekly':
      recurrence = {
        type: 2,
        repeat_interval: input.interval,
        weekly_days: (input.daysOfWeek ?? []).map((day) => WEEKDAYS.indexOf(day) + 1).join(','),
      };
      break;
    case 'monthly':
      if (input.weekOfMonth) {
        const days = input.daysOfWeek ?? [];
        if (days.length !== 1) {
          return fail(
            'recurrence.daysOfWeek: a monthly Zoom meeting on a weekday takes exactly one weekday.'
          );
        }
        recurrence = {
          type: 3,
          repeat_interval: input.interval,
          monthly_week: WEEK_INDEX[input.weekOfMonth],
          monthly_week_day: WEEKDAYS.indexOf(days[0]) + 1,
        };
      } else {
        recurrence = {
          type: 3,
          repeat_interval: input.interval,
          monthly_day: input.dayOfMonth ?? 1,
        };
      }
      break;
  }
  if (input.until) recurrence.end_date_time = `${input.until}T23:59:59Z`;
  else if (input.occurrences) recurrence.end_times = input.occurrences;

  const { startDate: _startDate, ...rest } = input;
  return { ok: true, val: { recurrence, description: describeRecurrence(input), input: rest } };
}
