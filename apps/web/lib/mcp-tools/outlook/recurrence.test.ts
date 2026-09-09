/**
 * parseRecurrence: the model's plain repeat becomes Graph's
 * patternedRecurrence, with what it left unsaid derived from the start
 * date, and every complaint naming the field at fault.
 */

import { describeRecurrence, parseRecurrence } from './recurrence';

const START = '2026-09-16T11:00:00'; // a Wednesday
const TZ = 'America/Los_Angeles';

function parsed(value: unknown, start = START) {
  const result = parseRecurrence(value, start, TZ);
  if (!result.ok) throw new Error(result.error);
  return result.val;
}

function complaint(value: unknown, start = START): string {
  const result = parseRecurrence(value, start, TZ);
  if (result.ok) throw new Error('expected a complaint');
  return result.error;
}

describe('parseRecurrence', () => {
  it('is null for no recurrence at all', () => {
    expect(parsed(undefined)).toBeNull();
    expect(parsed(null)).toBeNull();
    expect(parsed('')).toBeNull();
  });

  it('a weekly repeat with no days named falls on the start’s weekday, with no end', () => {
    expect(parsed({ frequency: 'weekly' })).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'] },
      range: { type: 'noEnd', startDate: '2026-09-16', recurrenceTimeZone: TZ },
    });
  });

  it('takes weekdays in any case or abbreviation, deduplicated, and an interval as text', () => {
    expect(
      parsed({ frequency: 'weekly', interval: '2', daysOfWeek: ['Monday', 'wed', 'MONDAY'] })
    ).toMatchObject({
      pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'] },
    });
  });

  it('accepts the object as JSON text, as a model without the schema sends it', () => {
    expect(
      parsed('{"frequency":"weekly","interval":1,"daysOfWeek":["Wednesday"],"noEndDate":true}')
    ).toMatchObject({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['wednesday'] },
      range: { type: 'noEnd' },
    });
  });

  it('daily, every N days, for N occurrences', () => {
    expect(parsed({ frequency: 'daily', interval: 3, occurrences: '5' })).toEqual({
      pattern: { type: 'daily', interval: 3 },
      range: {
        type: 'numbered',
        startDate: '2026-09-16',
        numberOfOccurrences: 5,
        recurrenceTimeZone: TZ,
      },
    });
  });

  it('monthly on a date defaults to the start’s day; until sets an end date', () => {
    expect(parsed({ frequency: 'monthly', until: '2027-03-31' })).toEqual({
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 16 },
      range: {
        type: 'endDate',
        startDate: '2026-09-16',
        endDate: '2027-03-31',
        recurrenceTimeZone: TZ,
      },
    });
    expect(parsed({ frequency: 'monthly', dayOfMonth: '1' })).toMatchObject({
      pattern: { type: 'absoluteMonthly', dayOfMonth: 1 },
    });
  });

  it('monthly on a weekday: weekOfMonth with daysOfWeek is relativeMonthly', () => {
    expect(
      parsed({ frequency: 'monthly', weekOfMonth: 'last', daysOfWeek: ['friday'] })
    ).toMatchObject({
      pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday'], index: 'last' },
    });
    // Weekdays alone, no date: the first such weekday.
    expect(parsed({ frequency: 'monthly', daysOfWeek: ['tuesday'] })).toMatchObject({
      pattern: { type: 'relativeMonthly', index: 'first' },
    });
  });

  it('yearly defaults to the start’s date; a weekday form takes month and index', () => {
    expect(parsed({ frequency: 'yearly' })).toMatchObject({
      pattern: { type: 'absoluteYearly', interval: 1, dayOfMonth: 16, month: 9 },
    });
    expect(
      parsed({ frequency: 'yearly', month: 11, weekOfMonth: 'fourth', daysOfWeek: ['thursday'] })
    ).toMatchObject({
      pattern: { type: 'relativeYearly', month: 11, index: 'fourth', daysOfWeek: ['thursday'] },
    });
  });

  it('until wins over occurrences when both are given', () => {
    expect(
      parsed({ frequency: 'daily', until: '2026-10-01', occurrences: 3 })!.range
    ).toMatchObject({
      type: 'endDate',
      endDate: '2026-10-01',
    });
  });

  it('names the field at fault', () => {
    expect(complaint('every week')).toContain('recurrence must be an object');
    expect(complaint({ frequency: 'fortnightly' })).toContain('recurrence.frequency');
    expect(complaint({ frequency: 'weekly', interval: 0 })).toContain('recurrence.interval');
    expect(complaint({ frequency: 'weekly', interval: 'two' })).toContain('recurrence.interval');
    expect(complaint({ frequency: 'weekly', daysOfWeek: ['someday'] })).toContain(
      'recurrence.daysOfWeek'
    );
    expect(complaint({ frequency: 'monthly', weekOfMonth: 'fifth' })).toContain(
      'recurrence.weekOfMonth'
    );
    expect(complaint({ frequency: 'monthly', weekOfMonth: 'last' })).toContain(
      'needs recurrence.daysOfWeek'
    );
    expect(complaint({ frequency: 'monthly', dayOfMonth: 32 })).toContain('recurrence.dayOfMonth');
    expect(complaint({ frequency: 'yearly', month: 13 })).toContain('recurrence.month');
    expect(complaint({ frequency: 'daily', until: 'next June' })).toContain('recurrence.until');
    expect(complaint({ frequency: 'daily', until: '2026-09-01' })).toContain('before the start');
    expect(complaint({ frequency: 'daily', occurrences: 0 })).toContain('recurrence.occurrences');
    expect(complaint({ frequency: 'daily' }, '11am tomorrow')).toContain('start must begin');
  });
});

describe('describeRecurrence', () => {
  it('says the series in a person’s words', () => {
    expect(describeRecurrence(parsed({ frequency: 'weekly' })!)).toBe('every week on Wednesday');
    expect(
      describeRecurrence(
        parsed({
          frequency: 'weekly',
          interval: 2,
          daysOfWeek: ['mon', 'wed'],
          until: '2026-12-18',
        })!
      )
    ).toBe('every other week on Monday and Wednesday until 2026-12-18');
    expect(describeRecurrence(parsed({ frequency: 'daily', interval: 3, occurrences: 5 })!)).toBe(
      'every 3 days, 5 times'
    );
    expect(describeRecurrence(parsed({ frequency: 'monthly', dayOfMonth: 22 })!)).toBe(
      'every month on the 22nd'
    );
    expect(
      describeRecurrence(
        parsed({ frequency: 'monthly', weekOfMonth: 'last', daysOfWeek: ['friday'] })!
      )
    ).toBe('every month on the last Friday');
    expect(describeRecurrence(parsed({ frequency: 'yearly' })!)).toBe('every year on September 16');
    expect(
      describeRecurrence(
        parsed({ frequency: 'yearly', month: 11, weekOfMonth: 'fourth', daysOfWeek: ['thursday'] })!
      )
    ).toBe('every year on the fourth Thursday of November');
  });
});
