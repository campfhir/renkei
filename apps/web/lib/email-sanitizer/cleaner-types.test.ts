/**
 * The editor's type declarations must match what the sandbox really passes.
 *
 * This is a drift test, not a formality. Autocomplete that offers a field
 * the guest never receives produces a script that reads `undefined` and
 * fails — and a failing script is a recorded no-op, so the message indexes
 * uncleaned and nobody finds out from the UI. The check runs against the
 * real marshalling code rather than a copy of it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALENDAR_ONLY_FIELDS, CLEANER_FIELDS, CLEANER_TYPES } from './cleaner-types';

const RUNNER = join(__dirname, '../../../../packages/email-sanitizer/src/scripts/run.ts');

/** The object literal the runner JSON-encodes into the guest. */
function marshalledFields(): string[] {
  const source = readFileSync(RUNNER, 'utf8');
  const start = source.indexOf('const email = ${JSON.stringify({');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('})};', start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((match) => match[1]);
}

describe('cleaner type declarations', () => {
  it('declares exactly the fields the sandbox marshals', () => {
    const actual = marshalledFields().sort();
    expect(actual.length).toBeGreaterThan(0);
    expect([...CLEANER_FIELDS].sort()).toEqual(actual);
  });

  it('mentions every declared field in the .d.ts the editor loads', () => {
    for (const field of CLEANER_FIELDS) {
      expect(CLEANER_TYPES).toContain(`${field}:`);
    }
  });

  it('declares the script signature the docs promise', () => {
    expect(CLEANER_TYPES).toContain('(email: CleanerEmail) => string');
  });

  it('gives each kind its own type, discriminated on kind', () => {
    expect(CLEANER_TYPES).toContain('interface CleanerMessage extends CleanerItemBase');
    expect(CLEANER_TYPES).toContain('interface CleanerEvent extends CleanerItemBase');
    expect(CLEANER_TYPES).toContain('interface CleanerTask extends CleanerItemBase');
    expect(CLEANER_TYPES).toContain(
      'type CleanerItem = CleanerMessage | CleanerEvent | CleanerTask'
    );
    for (const kind of ["kind: 'msg'", "kind: 'evt'", "kind: 'task'"]) {
      expect(CLEANER_TYPES).toContain(kind);
    }
  });

  it('puts the calendar-only fields on CleanerEvent and nowhere narrower', () => {
    // The whole point of narrowing is that these are unreachable until a
    // script has established it is holding an invite. If one leaked onto
    // the base, every message script would autocomplete an attendee list
    // that is always empty.
    const base = CLEANER_TYPES.slice(
      CLEANER_TYPES.indexOf('interface CleanerItemBase'),
      CLEANER_TYPES.indexOf('interface CleanerMessage')
    );
    for (const field of CALENDAR_ONLY_FIELDS) {
      expect(base).not.toContain(`${field}:`);
    }

    const event = CLEANER_TYPES.slice(
      CLEANER_TYPES.indexOf('interface CleanerEvent'),
      CLEANER_TYPES.indexOf('interface CleanerTask')
    );
    for (const field of CALENDAR_ONLY_FIELDS) {
      expect(event).toContain(`${field}:`);
    }
  });
});
