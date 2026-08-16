/**
 * Schedule math. The properties that matter: the next run is strictly
 * after `from`, lands on the asked-for wall-clock time in the schedule's
 * own timezone, and DST transitions move the instant rather than the
 * wall-clock time.
 */

import { computeNextRun, isRecurrence, isValidTimezone } from './recurrence';

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
  });

  it('rejects malformed times, weekdays, and days', () => {
    expect(isRecurrence({ every: 'day', at: '24:00' })).toBe(false);
    expect(isRecurrence({ every: 'week', weekday: 7, at: '08:00' })).toBe(false);
    // 29+ would skip February; the type caps at 28 on purpose.
    expect(isRecurrence({ every: 'month', day: 29, at: '08:00' })).toBe(false);
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
