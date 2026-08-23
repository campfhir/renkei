/**
 * The opt-in contract's one load-bearing property: ABSENT MEANS OFF. Every
 * pre-existing grant has no `indexing` key, and the default must be that
 * nothing is indexed until the user says so.
 */

import { outlookIndexingOf } from './outlook-indexing';

describe('outlookIndexingOf', () => {
  it('defaults every category off when the preference is absent', () => {
    expect(outlookIndexingOf({})).toEqual({ mail: false, calendar: false, tasks: false });
    expect(outlookIndexingOf({ upn: 'a@b.c', tid: 't' })).toEqual({
      mail: false,
      calendar: false,
      tasks: false,
    });
  });

  it('reads explicit opt-ins and treats anything but true as off', () => {
    expect(outlookIndexingOf({ indexing: { mail: true, calendar: 'yes', tasks: 1 } })).toEqual({
      mail: true,
      calendar: false,
      tasks: false,
    });
  });

  it('tolerates a malformed preference shape', () => {
    expect(outlookIndexingOf({ indexing: 'all' })).toEqual({
      mail: false,
      calendar: false,
      tasks: false,
    });
    expect(outlookIndexingOf({ indexing: [true, true, true] })).toEqual({
      mail: false,
      calendar: false,
      tasks: false,
    });
  });
});
