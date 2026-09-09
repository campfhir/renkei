/**
 * parseZoomRecurrence: the shared repeat becomes Zoom's recurrence object,
 * and what Zoom cannot do (yearly, a long interval, several weekdays in a
 * month) is refused by field name before any request is made.
 */

import { describeZoomRecurrence, parseZoomRecurrence } from './recurrence';

const START = '2026-09-16T11:00:00'; // a Wednesday

function parsed(value: unknown) {
  const result = parseZoomRecurrence(value, START);
  if (!result.ok) throw new Error(result.error);
  if (!result.val) throw new Error('expected a recurrence');
  return result.val;
}

function complaint(value: unknown): string {
  const result = parseZoomRecurrence(value, START);
  if (result.ok) throw new Error('expected a complaint');
  return result.error;
}

describe('parseZoomRecurrence', () => {
  it('is null for no recurrence', () => {
    expect(parseZoomRecurrence(undefined, START)).toEqual({ ok: true, val: null });
  });

  it('weekly on the start’s weekday, Zoom counting Sunday as 1', () => {
    expect(parsed({ frequency: 'weekly' })).toEqual({
      recurrence: { type: 2, repeat_interval: 1, weekly_days: '4' },
      description: 'every week on Wednesday',
      input: { frequency: 'weekly', interval: 1, daysOfWeek: ['wednesday'] },
    });
    expect(
      parsed({ frequency: 'weekly', interval: '2', daysOfWeek: ['Mon', 'fri'] }).recurrence
    ).toEqual({ type: 2, repeat_interval: 2, weekly_days: '2,6' });
  });

  it('takes the object as JSON text, as the model sent it without the schema', () => {
    expect(
      parsed('{"type":"weekly","frequency":"weekly","repeatInterval":1,"weeklyDays":["Wednesday"]}')
        .recurrence
    ).toEqual({ type: 2, repeat_interval: 1, weekly_days: '4' });
  });

  it('daily with an end date ends at the close of that day, UTC; occurrences become end_times', () => {
    expect(parsed({ frequency: 'daily', interval: 3, until: '2026-10-01' }).recurrence).toEqual({
      type: 1,
      repeat_interval: 3,
      end_date_time: '2026-10-01T23:59:59Z',
    });
    expect(parsed({ frequency: 'daily', occurrences: '10' }).recurrence).toEqual({
      type: 1,
      repeat_interval: 1,
      end_times: 10,
    });
  });

  it('monthly on a date, or on one weekday of a week — the last Friday is week -1', () => {
    expect(parsed({ frequency: 'monthly' }).recurrence).toEqual({
      type: 3,
      repeat_interval: 1,
      monthly_day: 16,
    });
    expect(
      parsed({ frequency: 'monthly', weekOfMonth: 'last', daysOfWeek: ['friday'] }).recurrence
    ).toEqual({ type: 3, repeat_interval: 1, monthly_week: -1, monthly_week_day: 6 });
    expect(
      parsed({ frequency: 'monthly', weekOfMonth: 'second', daysOfWeek: ['tuesday'] }).description
    ).toBe('every month on the second Tuesday');
  });

  it('refuses what Zoom cannot do, by field', () => {
    expect(complaint({ frequency: 'yearly' })).toContain('not yearly');
    expect(complaint({ frequency: 'daily', interval: 91 })).toContain('at most every 90 days');
    expect(complaint({ frequency: 'weekly', interval: 13 })).toContain('at most every 12 weeks');
    expect(complaint({ frequency: 'monthly', interval: 4 })).toContain('at most every 3 months');
    expect(
      complaint({ frequency: 'monthly', weekOfMonth: 'first', daysOfWeek: ['monday', 'friday'] })
    ).toContain('exactly one weekday');
    expect(complaint({ frequency: 'weekly', daysOfWeek: ['someday'] })).toContain(
      'recurrence.daysOfWeek'
    );
  });
});

describe('describeZoomRecurrence', () => {
  it('reads a series back from Zoom’s shape', () => {
    expect(describeZoomRecurrence({ type: 2, repeat_interval: 1, weekly_days: '2,4' }, START)).toBe(
      'every week on Monday and Wednesday'
    );
    expect(
      describeZoomRecurrence(
        { type: 3, repeat_interval: 1, monthly_week: -1, monthly_week_day: 6, end_times: 6 },
        START
      )
    ).toBe('every month on the last Friday, 6 times');
    expect(
      describeZoomRecurrence(
        { type: 1, repeat_interval: 3, end_date_time: '2026-10-01T23:59:59Z' },
        START
      )
    ).toBe('every 3 days until 2026-10-01');
    expect(describeZoomRecurrence({ type: 3, repeat_interval: 2 }, START)).toBe(
      'every other month on the 16th'
    );
  });

  it('is null for no recurrence', () => {
    expect(describeZoomRecurrence(undefined, START)).toBeNull();
    expect(describeZoomRecurrence({ type: 9 }, START)).toBeNull();
  });
});
