/**
 * The opt-in contract's one load-bearing property: ABSENT MEANS OFF. Every
 * pre-existing grant has no `indexing` key, and the default must be that
 * nothing happens in the background until the user says so.
 */

import { outlookIndexingOf, OUTLOOK_INDEXING_CATEGORIES } from './outlook-indexing';

describe('outlookIndexingOf', () => {
  it('defaults off when the preference is absent', () => {
    expect(outlookIndexingOf({})).toEqual({ mail: false });
    expect(outlookIndexingOf({ upn: 'a@b.c', tid: 't' })).toEqual({ mail: false });
  });

  it('reads an explicit opt-in and treats anything but true as off', () => {
    expect(outlookIndexingOf({ indexing: { mail: true } })).toEqual({ mail: true });
    expect(outlookIndexingOf({ indexing: { mail: 1 } })).toEqual({ mail: false });
  });

  it('ignores calendar and tasks flags left on an older grant', () => {
    // Calendar and To Do left the index; a stored opt-in must not resurrect
    // either, and must not leak into the parsed shape.
    expect(outlookIndexingOf({ indexing: { mail: true, calendar: true, tasks: true } })).toEqual({
      mail: true,
    });
    expect(OUTLOOK_INDEXING_CATEGORIES).toEqual(['mail']);
  });

  it('tolerates a malformed preference shape', () => {
    expect(outlookIndexingOf({ indexing: 'all' })).toEqual({ mail: false });
    expect(outlookIndexingOf({ indexing: [true, true, true] })).toEqual({ mail: false });
  });
});
