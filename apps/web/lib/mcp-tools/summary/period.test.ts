/**
 * Period resolution. The zone maths is the part worth pinning: "today" is a
 * property of the asker, not the data, and getting it wrong silently returns
 * the wrong day's work.
 */

import { resolvePeriod } from './period';

describe('resolvePeriod', () => {
  it('bounds "today" by the caller’s local day, not UTC', () => {
    // 21:00 UTC on the 12th is already the 13th in Auckland (UTC+13).
    const now = new Date('2026-08-12T21:00:00Z');
    const period = resolvePeriod({ period: 'today', timeZone: 'Pacific/Auckland' }, now);

    expect(period.start).toBe('2026-08-12T12:00:00.000Z'); // 13 Aug 00:00 NZST
    expect(period.end).toBe('2026-08-13T12:00:00.000Z');
    expect(period.timeZone).toBe('Pacific/Auckland');
  });

  it('gives a different window than UTC would for the same instant', () => {
    const now = new Date('2026-08-12T21:00:00Z');
    const auckland = resolvePeriod({ period: 'today', timeZone: 'Pacific/Auckland' }, now);
    const utc = resolvePeriod({ period: 'today', timeZone: 'UTC' }, now);
    // Computing in UTC here would hand an Auckland user most of yesterday
    // and none of the morning they are asking about.
    expect(auckland.start).not.toBe(utc.start);
  });

  it('runs "today" to the end of the local day, not to now', () => {
    // A morning summary exists to show what is still to come; cutting at the
    // current instant would hide every remaining meeting.
    const now = new Date('2026-08-12T09:00:00Z');
    const period = resolvePeriod({ period: 'today', timeZone: 'UTC' }, now);
    expect(period.end).toBe('2026-08-13T00:00:00.000Z');
    expect(new Date(period.end).getTime()).toBeGreaterThan(now.getTime());
  });

  it('resolves yesterday as the day before, ending at today’s start', () => {
    const now = new Date('2026-08-12T09:00:00Z');
    const period = resolvePeriod({ period: 'yesterday', timeZone: 'UTC' }, now);
    expect(period.start).toBe('2026-08-11T00:00:00.000Z');
    expect(period.end).toBe('2026-08-12T00:00:00.000Z');
    expect(period.label).toBe('yesterday');
  });

  it('counts multi-day presets inclusive of today', () => {
    const now = new Date('2026-08-12T09:00:00Z');
    const period = resolvePeriod({ period: 'last-7-days', timeZone: 'UTC' }, now);
    // 6 days back plus today = 7.
    expect(period.start).toBe('2026-08-06T00:00:00.000Z');
    expect(period.end).toBe('2026-08-13T00:00:00.000Z');
  });

  it('handles a DST boundary without landing in the wrong day', () => {
    // US DST ends 2026-11-01: the offset at "now" and at local midnight differ.
    const now = new Date('2026-11-01T18:00:00Z'); // 13:00 EST
    const period = resolvePeriod({ period: 'today', timeZone: 'America/New_York' }, now);
    expect(period.start).toBe('2026-11-01T04:00:00.000Z'); // midnight EDT, before the change
  });

  it('lets an explicit range override the preset', () => {
    const period = resolvePeriod({
      period: 'today',
      after: '2026-01-01T00:00:00Z',
      before: '2026-02-01T00:00:00Z',
    });
    expect(period.start).toBe('2026-01-01T00:00:00.000Z');
    expect(period.end).toBe('2026-02-01T00:00:00.000Z');
    expect(period.label).toContain('2026-01-01');
  });

  it('falls back to UTC rather than failing on a bad zone', () => {
    // A slightly wrong window beats no summary, and the label records what
    // was actually used.
    const period = resolvePeriod({ period: 'today', timeZone: 'Mars/Olympus_Mons' });
    expect(period.timeZone).toBe('UTC');
  });

  it('defaults to today when nothing is asked for', () => {
    expect(resolvePeriod({}).label).toBe('today');
  });
});
