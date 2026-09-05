/**
 * Schedule math. The properties that matter: the next run is strictly
 * after `from`, lands on the asked-for wall-clock time in the schedule's
 * own timezone, and DST transitions move the instant rather than the
 * wall-clock time.
 */

import {
  blackoutPredicate,
  computeNextRun,
  computeNextRunForSchedule,
  describeRecurrence,
  describeSchedule,
  isActiveHoursWindow,
  isBlackoutEntry,
  isRecurrence,
  recurrenceIssue,
  isValidTimezone,
  parseScheduleConfig,
  type ScheduleConfig,
} from './recurrence';

const wallClockInZone = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);

describe('isRecurrence', () => {
  it('accepts each preset shape', () => {
    expect(isRecurrence({ every: 'hour' })).toBe(true);
    expect(isRecurrence({ every: 'day', at: '09:30' })).toBe(true);
    expect(isRecurrence({ every: 'weekday', at: '08:00' })).toBe(true);
    expect(isRecurrence({ every: 'week', weekday: 1, at: '08:00' })).toBe(true);
    expect(isRecurrence({ every: 'month', day: 28, at: '23:59' })).toBe(true);
    // Day 29-31 is CLAMPED to short months, so it's a legal ask now.
    expect(isRecurrence({ every: 'month', day: 31, at: '08:00' })).toBe(true);
    expect(isRecurrence({ every: 'month', on: 'last-day', at: '17:00' })).toBe(true);
    expect(isRecurrence({ every: 'month', on: 'first-weekday', at: '08:00' })).toBe(true);
    expect(isRecurrence({ every: 'month', on: 'last-weekday', at: '17:00' })).toBe(true);
    expect(isRecurrence({ every: 'month', nth: 3, weekday: 5, at: '12:00' })).toBe(true);
    expect(isRecurrence({ every: 'month', nth: -1, weekday: 5, at: '12:00' })).toBe(true);
  });

  it('rejects malformed times, weekdays, days, and mixed month forms', () => {
    expect(isRecurrence({ every: 'day', at: '24:00' })).toBe(false);
    expect(isRecurrence({ every: 'week', weekday: 7, at: '08:00' })).toBe(false);
    expect(isRecurrence({ every: 'month', day: 32, at: '08:00' })).toBe(false);
    expect(isRecurrence({ every: 'month', nth: 5, weekday: 1, at: '08:00' })).toBe(false);
    expect(isRecurrence({ every: 'month', on: 'second-tuesday', at: '08:00' })).toBe(false);
    // Two monthly discriminants at once is ambiguous — rejected.
    expect(isRecurrence({ every: 'month', day: 1, on: 'last-day', at: '08:00' })).toBe(false);
    expect(isRecurrence({ every: 'never' })).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('computeNextRun', () => {
  it('hourly: next top of hour', () => {
    const from = new Date('2026-08-16T14:25:00Z');
    expect(computeNextRun({ every: 'hour' }, 'UTC', from).toISOString()).toBe(
      '2026-08-16T15:00:00.000Z'
    );
  });

  it('daily: later today when the time has not passed, tomorrow when it has', () => {
    // 08:00 PDT = 15:00Z.
    const before = new Date('2026-08-16T14:00:00Z');
    const after = new Date('2026-08-16T16:00:00Z');
    const rec = { every: 'day', at: '08:00' } as const;
    expect(computeNextRun(rec, 'America/Los_Angeles', before).toISOString()).toBe(
      '2026-08-16T15:00:00.000Z'
    );
    expect(computeNextRun(rec, 'America/Los_Angeles', after).toISOString()).toBe(
      '2026-08-17T15:00:00.000Z'
    );
  });

  it('daily: an exact hit schedules the NEXT day, never itself', () => {
    const exactly = new Date('2026-08-16T15:00:00Z');
    const next = computeNextRun({ every: 'day', at: '08:00' }, 'America/Los_Angeles', exactly);
    expect(next.toISOString()).toBe('2026-08-17T15:00:00.000Z');
  });

  it('weekly: lands on the asked-for weekday', () => {
    // 2026-08-16 is a Sunday.
    const from = new Date('2026-08-16T12:00:00Z');
    const next = computeNextRun(
      { every: 'week', weekday: 3, at: '09:00' },
      'America/New_York',
      from
    );
    // Wednesday 2026-08-19, 09:00 EDT = 13:00Z.
    expect(next.toISOString()).toBe('2026-08-19T13:00:00.000Z');
  });

  it('monthly: next month once this month’s day has passed', () => {
    const from = new Date('2026-08-16T12:00:00Z');
    const next = computeNextRun({ every: 'month', day: 5, at: '10:00' }, 'UTC', from);
    expect(next.toISOString()).toBe('2026-09-05T10:00:00.000Z');
  });

  it('keeps the wall-clock time across a DST transition', () => {
    // US DST ends 2026-11-01: PDT (UTC-7) → PST (UTC-8). A daily 08:00
    // schedule shifts its UTC instant by an hour; the local time must not.
    const beforeShift = new Date('2026-10-30T00:00:00Z');
    const zone = 'America/Los_Angeles';
    const first = computeNextRun({ every: 'day', at: '08:00' }, zone, beforeShift);
    const afterShift = new Date('2026-11-02T00:00:00Z');
    const second = computeNextRun({ every: 'day', at: '08:00' }, zone, afterShift);
    expect(wallClockInZone(first, zone)).toBe('08:00');
    expect(wallClockInZone(second, zone)).toBe('08:00');
    expect(first.toISOString()).toBe('2026-10-30T15:00:00.000Z'); // UTC-7
    expect(second.toISOString()).toBe('2026-11-02T16:00:00.000Z'); // UTC-8
  });

  it('resolves a nonexistent spring-forward time to the shifted instant', () => {
    // US DST starts 2026-03-08; 02:30 does not exist in Los Angeles.
    const from = new Date('2026-03-08T00:00:00Z');
    const next = computeNextRun({ every: 'day', at: '02:30' }, 'America/Los_Angeles', from);
    // The candidate resolves an hour later on the clock (03:30 PDT).
    expect(next.toISOString()).toBe('2026-03-08T10:30:00.000Z');
  });
});

describe('computeNextRun: weekdays', () => {
  it('fires Monday through Friday and skips the weekend', () => {
    const rec = { every: 'weekday', at: '08:00' } as const;
    // 2026-08-14 is a Friday; after Friday's 08:00 the next run is Monday.
    const friday = computeNextRun(rec, 'UTC', new Date('2026-08-14T09:00:00Z'));
    expect(friday.toISOString()).toBe('2026-08-17T08:00:00.000Z'); // Monday
    // Mid-Thursday → Friday.
    const thursday = computeNextRun(rec, 'UTC', new Date('2026-08-13T09:00:00Z'));
    expect(thursday.toISOString()).toBe('2026-08-14T08:00:00.000Z');
    // Saturday → Monday.
    const saturday = computeNextRun(rec, 'UTC', new Date('2026-08-15T00:00:00Z'));
    expect(saturday.toISOString()).toBe('2026-08-17T08:00:00.000Z');
  });

  it('reads as prose', () => {
    expect(describeRecurrence({ every: 'weekday', at: '08:00' })).toBe(
      'every weekday (Mon–Fri) at 08:00'
    );
  });
});

describe('computeNextRun: new monthly forms', () => {
  it('clamps day 31 to short months', () => {
    // From mid-April (30 days): the "31st" fires Apr 30.
    const april = computeNextRun(
      { every: 'month', day: 31, at: '10:00' },
      'UTC',
      new Date('2026-04-10T00:00:00Z')
    );
    expect(april.toISOString()).toBe('2026-04-30T10:00:00.000Z');
    // From late January 2027 (after the 31st passed): February clamps to 28.
    const february = computeNextRun(
      { every: 'month', day: 31, at: '10:00' },
      'UTC',
      new Date('2027-01-31T11:00:00Z')
    );
    expect(february.toISOString()).toBe('2027-02-28T10:00:00.000Z');
  });

  it('last day of the month, leap February included', () => {
    const next = computeNextRun(
      { every: 'month', on: 'last-day', at: '17:00' },
      'UTC',
      new Date('2028-02-01T00:00:00Z')
    );
    expect(next.toISOString()).toBe('2028-02-29T17:00:00.000Z');
  });

  it('first weekday: the 1st when Mon-Fri, else the following Monday', () => {
    // 2026-08-01 is a Saturday → first weekday is Monday the 3rd.
    const august = computeNextRun(
      { every: 'month', on: 'first-weekday', at: '08:00' },
      'UTC',
      new Date('2026-07-31T12:00:00Z')
    );
    expect(august.toISOString()).toBe('2026-08-03T08:00:00.000Z');
    // 2026-09-01 is a Tuesday → the 1st itself.
    const september = computeNextRun(
      { every: 'month', on: 'first-weekday', at: '08:00' },
      'UTC',
      new Date('2026-08-20T12:00:00Z')
    );
    expect(september.toISOString()).toBe('2026-09-01T08:00:00.000Z');
  });

  it('last weekday: steps back over a weekend ending', () => {
    // 2026-08-31 is a Monday → the last weekday IS the 31st.
    const august = computeNextRun(
      { every: 'month', on: 'last-weekday', at: '17:00' },
      'UTC',
      new Date('2026-08-20T12:00:00Z')
    );
    expect(august.toISOString()).toBe('2026-08-31T17:00:00.000Z');
    // 2027-01-31 is a Sunday → the last weekday is Friday the 29th.
    const january = computeNextRun(
      { every: 'month', on: 'last-weekday', at: '17:00' },
      'UTC',
      new Date('2027-01-10T12:00:00Z')
    );
    expect(january.toISOString()).toBe('2027-01-29T17:00:00.000Z');
  });

  it('nth weekday, including "last" in a five-Friday month', () => {
    // 3rd Friday of August 2026 is the 21st.
    const third = computeNextRun(
      { every: 'month', nth: 3, weekday: 5, at: '12:00' },
      'UTC',
      new Date('2026-08-01T00:00:00Z')
    );
    expect(third.toISOString()).toBe('2026-08-21T12:00:00.000Z');
    // October 2026 has five Fridays (2, 9, 16, 23, 30): last is the 30th.
    const last = computeNextRun(
      { every: 'month', nth: -1, weekday: 5, at: '12:00' },
      'UTC',
      new Date('2026-10-01T00:00:00Z')
    );
    expect(last.toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });
});

describe('parseScheduleConfig', () => {
  it('reads the current shape and drops empty optionals', () => {
    const parsed = parseScheduleConfig({
      recurrences: [{ every: 'day', at: '09:00' }],
      timezone: 'UTC',
      startAt: '2026-09-01',
      blackouts: [{ date: '2026-12-25' }],
      blackoutPolicy: 'skip',
    });
    expect(parsed).toEqual({
      recurrences: [{ every: 'day', at: '09:00' }],
      timezone: 'UTC',
      startAt: '2026-09-01',
      blackouts: [{ date: '2026-12-25' }],
      blackoutPolicy: 'skip',
    });
  });

  it('upgrades the legacy single-recurrence shape', () => {
    const parsed = parseScheduleConfig({
      recurrence: { every: 'week', weekday: 1, at: '08:00' },
      timezone: 'America/New_York',
    });
    expect(parsed).toEqual({
      recurrences: [{ every: 'week', weekday: 1, at: '08:00' }],
      timezone: 'America/New_York',
    });
  });

  it('rejects malformed configs whole', () => {
    expect(parseScheduleConfig(null)).toBeNull();
    expect(parseScheduleConfig({ recurrences: [], timezone: 'UTC' })).toBeNull();
    expect(parseScheduleConfig({ recurrences: [{ every: 'nope' }], timezone: 'UTC' })).toBeNull();
    expect(
      parseScheduleConfig({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        startAt: '2026-02-30',
      })
    ).toBeNull();
    expect(
      parseScheduleConfig({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        blackouts: [{ date: 'someday' }],
      })
    ).toBeNull();
    expect(
      parseScheduleConfig({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        activeHours: [{ start: '20:00', end: '08:00' }],
      })
    ).toBeNull();
  });

  it('reads activeHours and drops an empty list', () => {
    const parsed = parseScheduleConfig({
      recurrences: [{ every: 'hour' }],
      timezone: 'UTC',
      activeHours: [
        { start: '00:00', end: '08:00' },
        { start: '19:00', end: '24:00' },
      ],
    });
    expect(parsed?.activeHours).toEqual([
      { start: '00:00', end: '08:00' },
      { start: '19:00', end: '24:00' },
    ]);
    expect(
      parseScheduleConfig({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        activeHours: [],
      })?.activeHours
    ).toBeUndefined();
  });
});

describe('isActiveHoursWindow', () => {
  it('accepts HH:MM windows, including "24:00" as an end', () => {
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00' })).toBe(true);
    expect(isActiveHoursWindow({ start: '19:00', end: '24:00' })).toBe(true);
    expect(isActiveHoursWindow({ start: '00:00', end: '00:01' })).toBe(true);
  });

  it('rejects a reversed or empty range, "24:00" as a start, and junk', () => {
    expect(isActiveHoursWindow({ start: '20:00', end: '08:00' })).toBe(false);
    expect(isActiveHoursWindow({ start: '08:00', end: '08:00' })).toBe(false);
    expect(isActiveHoursWindow({ start: '24:00', end: '08:00' })).toBe(false);
    expect(isActiveHoursWindow({ start: '08:00', end: '25:00' })).toBe(false);
    expect(isActiveHoursWindow({ start: '08:00' })).toBe(false);
  });

  it('accepts an optional weekdays scope', () => {
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00', weekdays: [1, 2, 3, 4, 5] })).toBe(
      true
    );
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00', weekdays: [0] })).toBe(true);
  });

  it('rejects a malformed weekdays scope', () => {
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00', weekdays: [] })).toBe(false);
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00', weekdays: [7] })).toBe(false);
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00', weekdays: ['1'] })).toBe(false);
    expect(isActiveHoursWindow({ start: '08:00', end: '20:00', weekdays: 'mon' })).toBe(false);
  });
});

describe('isBlackoutEntry / blackoutPredicate', () => {
  it('validates the three entry forms', () => {
    expect(isBlackoutEntry({ date: '2026-12-25' })).toBe(true);
    expect(isBlackoutEntry({ start: '2026-12-24', end: '2026-12-26', label: 'Xmas' })).toBe(true);
    expect(isBlackoutEntry({ annual: '12-25' })).toBe(true);
    expect(isBlackoutEntry({ date: '2026-02-30' })).toBe(false);
    expect(isBlackoutEntry({ start: '2026-12-26', end: '2026-12-24' })).toBe(false);
    expect(isBlackoutEntry({ annual: '13-01' })).toBe(false);
  });

  it('matches one-offs, ranges, and annual dates across years', () => {
    const blackout = blackoutPredicate([
      { date: '2026-07-03' },
      { start: '2026-12-24', end: '2026-12-26' },
      { annual: '01-01' },
    ]);
    expect(blackout('2026-07-03')).toBe(true);
    expect(blackout('2026-12-25')).toBe(true);
    expect(blackout('2026-12-27')).toBe(false);
    expect(blackout('2027-01-01')).toBe(true);
    expect(blackout('2031-01-01')).toBe(true);
  });
});

describe('computeNextRunForSchedule', () => {
  const daily = (at: string) => ({ every: 'day' as const, at });

  it('multi-rule union: the earliest candidate wins', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'month', day: 20, at: '10:00' }, daily('18:00')],
      timezone: 'UTC',
    };
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-16T18:00:00.000Z');
  });

  it('a future startAt clamps the walk; the start date itself qualifies', () => {
    const config: ScheduleConfig = {
      recurrences: [daily('09:00')],
      timezone: 'UTC',
      startAt: '2026-09-01',
    };
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-09-01T09:00:00.000Z');
  });

  it("policy 'after' cascades across a consecutive blackout range", () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'month', day: 25, at: '09:00' }],
      timezone: 'UTC',
      blackouts: [{ start: '2026-12-24', end: '2026-12-26' }],
      blackoutPolicy: 'after',
    };
    const next = computeNextRunForSchedule(config, new Date('2026-12-01T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-12-27T09:00:00.000Z');
  });

  it("policy 'before' runs the previous clear day, and degrades to skip in the past", () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'month', day: 25, at: '09:00' }],
      timezone: 'UTC',
      blackouts: [{ start: '2026-12-24', end: '2026-12-26' }],
      blackoutPolicy: 'before',
    };
    const early = computeNextRunForSchedule(config, new Date('2026-12-01T00:00:00Z'));
    expect(early.toISOString()).toBe('2026-12-23T09:00:00.000Z');
    // From Dec 24: the shifted day (the 23rd) already passed → the
    // occurrence is skipped and January's takes its place.
    const late = computeNextRunForSchedule(config, new Date('2026-12-24T00:00:00Z'));
    expect(late.toISOString()).toBe('2027-01-25T09:00:00.000Z');
  });

  it("policy 'skip' advances to the next natural occurrence", () => {
    const config: ScheduleConfig = {
      recurrences: [daily('09:00')],
      timezone: 'UTC',
      blackouts: [{ date: '2026-08-17' }],
      blackoutPolicy: 'skip',
    };
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T10:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-18T09:00:00.000Z');
  });

  it('the org calendar predicate composes with per-trigger blackouts', () => {
    const config: ScheduleConfig = {
      recurrences: [daily('09:00')],
      timezone: 'UTC',
      blackouts: [{ date: '2026-08-17' }],
      blackoutPolicy: 'skip',
    };
    const calendar = blackoutPredicate([{ date: '2026-08-18' }]);
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T10:00:00Z'), calendar);
    expect(next.toISOString()).toBe('2026-08-19T09:00:00.000Z');
  });

  it('an all-blackout schedule throws (the sweep disables with the reason)', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'month', day: 25, at: '09:00' }],
      timezone: 'UTC',
      // Every day for two years around the walk is blacked out.
      blackouts: [{ start: '2026-01-01', end: '2027-12-31' }],
      blackoutPolicy: 'after',
    };
    expect(() => computeNextRunForSchedule(config, new Date('2026-08-16T00:00:00Z'))).toThrow(
      /no next run/
    );
  });

  it('blackout dates are read in the schedule timezone at day boundaries', () => {
    // 2026-08-18 06:00Z is still Aug 17 in Los Angeles — a blackout on
    // the 17th must suppress it; the run lands Aug 18 09:00 PDT (16:00Z).
    const config: ScheduleConfig = {
      recurrences: [daily('09:00')],
      timezone: 'America/Los_Angeles',
      blackouts: [{ date: '2026-08-17' }],
      blackoutPolicy: 'skip',
    };
    const next = computeNextRunForSchedule(config, new Date('2026-08-17T05:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-18T16:00:00.000Z');
  });

  it('hourly runs resume after a blacked-out local day', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'hour' }],
      timezone: 'UTC',
      blackouts: [{ date: '2026-08-17' }],
    };
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T23:30:00Z'));
    // 00:00 on the 17th is blacked out; first clear hour is midnight the 18th.
    expect(next.toISOString()).toBe('2026-08-18T00:00:00.000Z');
  });

  it('active hours constrain an hourly rule to the window', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'hour' }],
      timezone: 'UTC',
      activeHours: [{ start: '08:00', end: '20:00' }],
    };
    // 09:30Z is already inside the window — next is the top of the next hour.
    expect(computeNextRunForSchedule(config, new Date('2026-08-16T09:30:00Z')).toISOString()).toBe(
      '2026-08-16T10:00:00.000Z'
    );
    // 19:30Z: the next top-of-hour (20:00) is the window's exclusive end —
    // skip to tomorrow's first in-window hour.
    expect(computeNextRunForSchedule(config, new Date('2026-08-16T19:30:00Z')).toISOString()).toBe(
      '2026-08-17T08:00:00.000Z'
    );
  });

  it('active hours union across multiple windows, including an overnight split', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'hour' }],
      timezone: 'UTC',
      activeHours: [
        { start: '00:00', end: '08:00' },
        { start: '19:00', end: '24:00' },
      ],
    };
    // 08:30Z is between the two windows — next in-window hour is 19:00.
    expect(computeNextRunForSchedule(config, new Date('2026-08-16T08:30:00Z')).toISOString()).toBe(
      '2026-08-16T19:00:00.000Z'
    );
    // 23:30Z is inside the overnight window — next hour (00:00) is too.
    expect(computeNextRunForSchedule(config, new Date('2026-08-16T23:30:00Z')).toISOString()).toBe(
      '2026-08-17T00:00:00.000Z'
    );
  });

  it('active hours are ignored by rules with an explicit "at" time', () => {
    const config: ScheduleConfig = {
      recurrences: [daily('22:00')],
      timezone: 'UTC',
      // Would exclude 22:00 for an hourly rule; a daily "at" rule ignores it.
      activeHours: [{ start: '08:00', end: '20:00' }],
    };
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T09:00:00Z'));
    expect(next.toISOString()).toBe('2026-08-16T22:00:00.000Z');
  });

  it('active hours scoped to weekdays skip the weekend', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'hour' }],
      timezone: 'UTC',
      // 2026-08-14 is a Friday; the 15th/16th are Sat/Sun.
      activeHours: [{ start: '08:00', end: '18:00', weekdays: [1, 2, 3, 4, 5] }],
    };
    // Friday 09:30Z is in-window on an allowed weekday — next top of hour.
    expect(computeNextRunForSchedule(config, new Date('2026-08-14T09:30:00Z')).toISOString()).toBe(
      '2026-08-14T10:00:00.000Z'
    );
    // Friday 17:30Z: window closes at 18:00, and Sat/Sun are excluded —
    // next in-window hour is Monday 08:00.
    expect(computeNextRunForSchedule(config, new Date('2026-08-14T17:30:00Z')).toISOString()).toBe(
      '2026-08-17T08:00:00.000Z'
    );
  });

  it('active hours compose with blackout dates', () => {
    const config: ScheduleConfig = {
      recurrences: [{ every: 'hour' }],
      timezone: 'UTC',
      activeHours: [{ start: '08:00', end: '20:00' }],
      blackouts: [{ date: '2026-08-17' }],
    };
    // From 19:30Z on the 16th: the 17th is blacked out entirely, so the
    // next in-window, clear hour is 08:00 on the 18th.
    const next = computeNextRunForSchedule(config, new Date('2026-08-16T19:30:00Z'));
    expect(next.toISOString()).toBe('2026-08-18T08:00:00.000Z');
  });
});

describe('describeRecurrence / describeSchedule', () => {
  it('one humanizer for every rule kind', () => {
    expect(describeRecurrence({ every: 'hour' })).toBe('every hour');
    expect(describeRecurrence({ every: 'day', at: '09:00' })).toBe('every day at 09:00');
    expect(describeRecurrence({ every: 'week', weekday: 1, at: '08:00' })).toBe(
      'every Monday at 08:00'
    );
    expect(describeRecurrence({ every: 'month', day: 31, at: '10:00' })).toBe(
      'the 31st of each month at 10:00'
    );
    expect(describeRecurrence({ every: 'month', on: 'last-weekday', at: '17:00' })).toBe(
      'the last weekday of each month at 17:00'
    );
    expect(describeRecurrence({ every: 'month', nth: -1, weekday: 5, at: '12:00' })).toBe(
      'the last Friday of each month at 12:00'
    );
  });

  it('joins rules and names the blackout policy', () => {
    expect(
      describeSchedule({
        recurrences: [
          { every: 'day', at: '09:00' },
          { every: 'month', on: 'last-day', at: '17:00' },
        ],
        timezone: 'UTC',
        startAt: '2026-09-01',
        calendarId: 'cal-1',
        blackoutPolicy: 'after',
      })
    ).toBe(
      'Every day at 09:00, and the last day of each month at 17:00 — starting 2026-09-01, ' +
        'shifting blackout dates to the next clear day'
    );
  });

  it('names active-hours windows', () => {
    expect(
      describeSchedule({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        activeHours: [
          { start: '00:00', end: '08:00' },
          { start: '19:00', end: '24:00' },
        ],
      })
    ).toBe('Every hour — active 00:00–08:00, 19:00–24:00');
  });

  it('names a weekday-scoped active-hours window, but not one covering every day', () => {
    expect(
      describeSchedule({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        activeHours: [{ start: '08:00', end: '18:00', weekdays: [1, 2, 3, 4, 5] }],
      })
    ).toBe('Every hour — active 08:00–18:00 Mon/Tue/Wed/Thu/Fri');
    expect(
      describeSchedule({
        recurrences: [{ every: 'hour' }],
        timezone: 'UTC',
        activeHours: [{ start: '08:00', end: '18:00', weekdays: [0, 1, 2, 3, 4, 5, 6] }],
      })
    ).toBe('Every hour — active 08:00–18:00');
  });
});

describe('recurrenceIssue explains the rejection', () => {
  it('names the vocabulary when `every` is not one of the forms', () => {
    // The empirical discovery this replaces: 'sunday' rejected with nothing
    // to say that a named day is `{ every: 'week', weekday: 0 }`.
    const issue = recurrenceIssue({ every: 'sunday', at: '09:00' });
    expect(issue).toContain('"every"');
    expect(issue).toContain('"week"');
    expect(issue).toContain('"sunday"');
  });

  it('names the offending key for each form', () => {
    expect(recurrenceIssue({ every: 'day', at: '24:00' })).toContain('"at"');
    expect(recurrenceIssue({ every: 'week', at: '08:00', weekday: 7 })).toContain('"weekday"');
    expect(recurrenceIssue({ every: 'month', at: '08:00', day: 32 })).toContain('"day"');
    expect(recurrenceIssue({ every: 'month', at: '08:00', on: 'sunday' })).toContain('"last-day"');
    expect(recurrenceIssue({ every: 'month', at: '08:00', nth: 5, weekday: 1 })).toContain('"nth"');
  });

  it('says which discriminants a monthly rule may carry when it names none or two', () => {
    for (const rule of [
      { every: 'month', at: '08:00' },
      { every: 'month', at: '08:00', day: 1, on: 'last-day' },
    ]) {
      const issue = recurrenceIssue(rule);
      expect(issue).toContain('exactly one');
      expect(issue).toContain('"nth"');
    }
  });

  it('is silent on every rule isRecurrence accepts, and speaks on every one it rejects', () => {
    const accepted: unknown[] = [
      { every: 'hour' },
      { every: 'day', at: '09:30' },
      { every: 'weekday', at: '08:00' },
      { every: 'week', weekday: 0, at: '08:00' },
      { every: 'month', day: 31, at: '08:00' },
      { every: 'month', on: 'last-weekday', at: '17:00' },
      { every: 'month', nth: -1, weekday: 5, at: '12:00' },
    ];
    const rejected: unknown[] = [
      null,
      'nope',
      [],
      { every: 'never' },
      { every: 'day' },
      { every: 'week', at: '08:00' },
      { every: 'month', at: '08:00', nth: 2 },
    ];
    for (const rule of accepted) {
      expect(recurrenceIssue(rule)).toBeNull();
      expect(isRecurrence(rule)).toBe(true);
    }
    for (const rule of rejected) {
      expect(recurrenceIssue(rule)).toEqual(expect.any(String));
      expect(isRecurrence(rule)).toBe(false);
    }
  });
});
