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

/**
 * The third rendering of the same shape.
 *
 * The checked-in cleaner library is pasteable payloads — no imports, so
 * `email: CleanerMessage` resolves against ambient declarations rather than
 * anything they bring with them. `cleaner-globals.d.ts` is that ambient
 * environment for `tsc`, exactly as `CLEANER_TYPES` is for Monaco.
 *
 * `tsc` catches a payload that reads a field the DECLARATIONS lack. Nothing
 * but this catches declarations that drift from what the sandbox actually
 * marshals — and that direction is the dangerous one, because it typechecks
 * cleanly and then reads `undefined` in production, where a script error is
 * a recorded no-op that indexes the message uncleaned.
 */
describe('cleaner library ambient declarations', () => {
  const GLOBALS = join(
    __dirname,
    '../../../../packages/email-sanitizer/scripts/cleaner-library/cleaner-globals.d.ts'
  );
  const globals = readFileSync(GLOBALS, 'utf8');

  it('declares exactly the fields the editor does', () => {
    for (const field of CLEANER_FIELDS) {
      expect(globals).toContain(`${field}:`);
    }
  });

  it('declares no field the editor does not', () => {
    // Property lines only — the doc comments above them mention plenty of
    // names that are not fields.
    const declared = new Set(
      [...globals.matchAll(/^ {2}([a-zA-Z]+)[?]?:/gm)].map((match) => match[1])
    );
    expect([...declared].sort()).toEqual([...CLEANER_FIELDS].sort());
  });

  it('gives each kind the same type the editor promises', () => {
    for (const name of [
      'interface CleanerItemBase',
      'interface CleanerMessage extends CleanerItemBase',
      'interface CleanerEvent extends CleanerItemBase',
      'interface CleanerTask extends CleanerItemBase',
      'interface CleanerEmail extends CleanerItemBase',
      'type CleanerItem = CleanerMessage | CleanerEvent | CleanerTask',
    ]) {
      expect(globals).toContain(name);
    }
  });

  it('keeps the calendar-only fields off the base here too', () => {
    const base = globals.slice(
      globals.indexOf('interface CleanerItemBase'),
      globals.indexOf('interface CleanerMessage')
    );
    for (const field of CALENDAR_ONLY_FIELDS) {
      expect(base).not.toContain(`${field}:`);
    }
  });

  it('stays ambient, with no import or export to make it a module', () => {
    // One `export` turns the file into a module, its declarations stop
    // being global, and every payload goes back to "Cannot find name
    // 'CleanerMessage'" — the failure this file was added to fix.
    expect(globals).not.toMatch(/^\s*(import|export)\b/m);
  });
});
