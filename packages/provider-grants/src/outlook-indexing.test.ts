/**
 * The opt-in contract's one load-bearing property: ABSENT MEANS OFF. Every
 * pre-existing grant has no `indexing` key, and the default must be that
 * nothing happens in the background until the user says so.
 */

import { outlookIndexingOf, OUTLOOK_INDEXING_CATEGORIES } from './outlook-indexing';

describe('outlookIndexingOf', () => {
  it('defaults every category off when the preference is absent', () => {
    expect(outlookIndexingOf({})).toEqual({ mail: false, tasks: false });
    expect(outlookIndexingOf({ upn: 'a@b.c', tid: 't' })).toEqual({ mail: false, tasks: false });
  });

  it('reads explicit opt-ins and treats anything but true as off', () => {
    expect(outlookIndexingOf({ indexing: { mail: true, tasks: 1 } })).toEqual({
      mail: true,
      tasks: false,
    });
  });

  it('ignores a calendar flag left on an older grant', () => {
    // Calendar left the index; a stored opt-in must not resurrect it, and
    // must not leak into the parsed shape either.
    expect(outlookIndexingOf({ indexing: { mail: true, calendar: true, tasks: true } })).toEqual({
      mail: true,
      tasks: true,
    });
    expect(OUTLOOK_INDEXING_CATEGORIES).toEqual(['mail', 'tasks']);
  });

  it('tolerates a malformed preference shape', () => {
    expect(outlookIndexingOf({ indexing: 'all' })).toEqual({ mail: false, tasks: false });
    expect(outlookIndexingOf({ indexing: [true, true, true] })).toEqual({
      mail: false,
      tasks: false,
    });
  });
});
