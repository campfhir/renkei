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
  isBlackoutEntry,
  isRecurrence,
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
});
