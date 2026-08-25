/**
 * The date arithmetic agents are not trusted to do in their heads. The
 * cases that matter are the ones a model gets plausibly wrong: a zone whose
 * offset changes, a "yesterday" that spans a DST boundary, and month ends.
 */

import { resolveTime } from './resolve-time';

const LA = 'America/Los_Angeles';

describe('resolveTime', () => {
  it('answers the case this was built for: yesterday at 19:00 Los Angeles', () => {
    // Fixed "now": 2026-08-25 10:00 PDT (UTC-7).
    const now = new Date('2026-08-25T17:00:00Z');
    const result = resolveTime({ timezone: LA, amount: -1, unit: 'day', atTime: '19:00' }, now);
    if (!result.ok) throw new Error(result.error);
    // 19:00 PDT on the 24th is 02:00Z on the 25th — the conversion a model
    // routinely gets an hour or a day wrong.
    expect(result.value.iso).toBe('2026-08-25T02:00:00.000Z');
    expect(result.value.local).toBe('2026-08-24 19:00 (UTC-07:00)');
    expect(result.value.offsetMinutes).toBe(-420);
  });

  it('keeps "yesterday at 19:00" at 19:00 across the autumn transition', () => {
    // Now: 2026-11-02 (PST, UTC-8). Yesterday, the 1st, is the day the
    // clocks went back — 25 hours long. The answer must still read 19:00
    // local, which is why calendar shifts move the wall clock, not the
    // elapsed milliseconds.
    const now = new Date('2026-11-02T18:00:00Z');
    const result = resolveTime({ timezone: LA, amount: -1, unit: 'day', atTime: '19:00' }, now);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.local).toBe('2026-11-01 19:00 (UTC-08:00)');
    expect(result.value.iso).toBe('2026-11-02T03:00:00.000Z');
  });

  it('separates elapsed hours from calendar days', () => {
    const now = new Date('2026-08-25T17:00:00Z');
    // -24 hours is exact elapsed time...
    const byHours = resolveTime({ timezone: LA, amount: -24, unit: 'hour' }, now);
    if (!byHours.ok) throw new Error(byHours.error);
    expect(byHours.value.iso).toBe('2026-08-24T17:00:00.000Z');
    // ...and with no atTime, -1 day lands on the same wall clock.
    const byDays = resolveTime({ timezone: LA, amount: -1, unit: 'day' }, now);
    if (!byDays.ok) throw new Error(byDays.error);
    expect(byDays.value.local).toBe('2026-08-24 10:00 (UTC-07:00)');
  });

  it('snaps to the start and end of a day in the target zone', () => {
    const now = new Date('2026-08-25T17:00:00Z');
    const start = resolveTime({ timezone: LA, startOf: 'day' }, now);
    const end = resolveTime({ timezone: LA, endOf: 'day' }, now);
    if (!start.ok || !end.ok) throw new Error('expected both to resolve');
    expect(start.value.iso).toBe('2026-08-25T07:00:00.000Z');
    expect(start.value.local).toBe('2026-08-25 00:00 (UTC-07:00)');
    expect(end.value.local).toBe('2026-08-25 23:59 (UTC-07:00)');
  });

  it('clamps a month shift onto a shorter month', () => {
    const now = new Date('2026-03-31T12:00:00Z');
    const result = resolveTime({ timezone: 'UTC', amount: -1, unit: 'month' }, now);
    if (!result.ok) throw new Error(result.error);
    // Feb has no 31st; the calendar convention is the last day.
    expect(result.value.local.startsWith('2026-02-28')).toBe(true);
  });

  it('measures from an explicit anchor instead of now', () => {
    const result = resolveTime(
      { timezone: 'UTC', anchor: '2026-01-15T00:00:00Z', amount: 1, unit: 'day', atTime: '06:30' },
      new Date('2030-01-01T00:00:00Z')
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.iso).toBe('2026-01-16T06:30:00.000Z');
  });

  it('names what was wrong rather than guessing', () => {
    const now = new Date('2026-08-25T17:00:00Z');
    const badZone = resolveTime({ timezone: 'Pacific Time', atTime: '19:00' }, now);
    expect(badZone.ok).toBe(false);
    if (!badZone.ok) expect(badZone.error).toContain('not a recognized IANA timezone');

    const badTime = resolveTime({ timezone: LA, atTime: '7pm' }, now);
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) expect(badTime.error).toContain('24-hour time of day');

    const badAnchor = resolveTime({ timezone: LA, anchor: 'last tuesday' }, now);
    expect(badAnchor.ok).toBe(false);
    if (!badAnchor.ok) expect(badAnchor.error).toContain('ISO 8601');
  });

  it('refuses to let a runaway shift leave the calendar', () => {
    const now = new Date('2026-08-25T17:00:00Z');
    const result = resolveTime({ timezone: 'UTC', amount: 10_000_000, unit: 'day' }, now);
    if (!result.ok) throw new Error(result.error);
    // Clamped, not NaN — a Date that overflowed would poison every caller.
    expect(Number.isFinite(result.value.epochMs)).toBe(true);
  });
});
