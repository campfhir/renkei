/**
 * Turning what someone types into an exact date chip. Presets cannot cover
 * every number a person will want ("30 mins ago", "4hr ago"), so the query
 * itself has to become a chip — and it must refuse anything it cannot read
 * precisely rather than guess.
 */

import { dateOptions, parseDateQuery } from './options';

const LA = 'America/Los_Angeles';

describe('parseDateQuery', () => {
  it.each([
    ['30 minutes ago', -30, 'minute'],
    ['30 mins ago', -30, 'minute'],
    ['30m ago', -30, 'minute'],
    ['4 hours ago', -4, 'hour'],
    ['4hr ago', -4, 'hour'],
    ['4h ago', -4, 'hour'],
    ['2 weeks ago', -2, 'week'],
    ['6 months ago', -6, 'month'],
    ['1 year ago', -1, 'year'],
  ])('reads %s as %i %s', (query, amount, unit) => {
    const option = parseDateQuery(LA, query);
    expect(option?.segment.amount).toBe(amount);
    expect(option?.segment.unit).toBe(unit);
    expect(option?.segment.timezone).toBe(LA);
  });

  it('reads forward-looking phrasings as positive', () => {
    expect(parseDateQuery(LA, 'in 2 weeks')?.segment.amount).toBe(2);
    expect(parseDateQuery(LA, '3 days from now')?.segment.amount).toBe(3);
    expect(parseDateQuery(LA, '5 hours later')?.segment.amount).toBe(5);
  });

  it('understands the words people actually type', () => {
    expect(parseDateQuery(LA, 'yesterday')?.segment).toMatchObject({ amount: -1, unit: 'day' });
    expect(parseDateQuery(LA, 'today')?.segment).toMatchObject({ amount: 0, unit: 'day' });
    expect(parseDateQuery(LA, 'tomorrow')?.segment).toMatchObject({ amount: 1, unit: 'day' });
  });

  it('picks up a time of day alongside the shift', () => {
    const option = parseDateQuery(LA, 'yesterday at 19:00');
    expect(option?.segment).toMatchObject({ amount: -1, unit: 'day', atTime: '19:00' });
    // A chip with a time wants the exact instant, not a bare date.
    expect(option?.segment.format).toBeUndefined();
    expect(parseDateQuery(LA, '2 days ago at 9:30')?.segment.atTime).toBe('09:30');
  });

  it('renders whole-day chips as dates and sub-day chips as instants', () => {
    expect(parseDateQuery(LA, 'yesterday')?.segment.format).toBe('date');
    expect(parseDateQuery(LA, '30 minutes ago')?.segment.format).toBeUndefined();
  });

  it('labels the chip in words, so the pill reads back', () => {
    expect(parseDateQuery(LA, '30 mins ago')?.label).toBe('30 minutes ago America/Los_Angeles');
    expect(parseDateQuery(LA, 'yesterday at 19:00')?.label).toBe(
      'yesterday 19:00 America/Los_Angeles'
    );
  });

  it('refuses what it cannot read exactly', () => {
    // Guessing here would reintroduce the very failure chips exist to end.
    expect(parseDateQuery(LA, 'sometime last week')).toBeNull();
    expect(parseDateQuery(LA, 'a few hours ago')).toBeNull();
    expect(parseDateQuery(LA, 'search my mail')).toBeNull();
    expect(parseDateQuery(LA, '')).toBeNull();
  });
});

describe('dateOptions', () => {
  it('offers presets when nothing is typed', () => {
    const options = dateOptions(LA);
    expect(options.length).toBeGreaterThan(5);
    expect(options.map((option) => option.name)).toContain('yesterday');
    expect(options.map((option) => option.name)).toContain('30 minutes ago');
  });

  it('puts what was typed first, without a duplicate preset behind it', () => {
    const options = dateOptions(LA, '30 minutes ago');
    expect(options[0]?.segment).toMatchObject({ amount: -30, unit: 'minute' });
    const identical = options.filter(
      (option) => option.segment.amount === -30 && option.segment.unit === 'minute'
    );
    expect(identical).toHaveLength(1);
  });
});
