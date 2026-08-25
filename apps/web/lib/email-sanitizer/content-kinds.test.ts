/**
 * These are the guards on a script's REACH, parsed from a request body.
 * Getting them wrong in the permissive direction means a script written for
 * mail quietly starts rewriting invites, so the tests are mostly about what
 * must NOT widen.
 */

import { describeKinds, isContentKind, parseContentKinds } from './content-kinds';

describe('parseContentKinds', () => {
  it('keeps the kinds that were asked for', () => {
    expect(parseContentKinds(['msg', 'evt'])).toEqual(['msg', 'evt']);
  });

  it('falls back to mail when the field is missing or malformed', () => {
    // A client that predates this field must not have its scripts widened,
    // and garbage must not either.
    expect(parseContentKinds(undefined)).toEqual(['msg']);
    expect(parseContentKinds('evt')).toEqual(['msg']);
    expect(parseContentKinds({ evt: true })).toEqual(['msg']);
  });

  it('drops kinds it does not recognise rather than passing them through', () => {
    expect(parseContentKinds(['evt', 'drive', 42, null])).toEqual(['evt']);
  });

  it('falls back to mail rather than accepting an empty reach', () => {
    // "Runs on nothing" is a disabled script; the enabled flag says that.
    expect(parseContentKinds([])).toEqual(['msg']);
    expect(parseContentKinds(['nonsense'])).toEqual(['msg']);
  });

  it('de-duplicates, so a repeated kind cannot run a script twice', () => {
    expect(parseContentKinds(['evt', 'evt', 'msg'])).toEqual(['evt', 'msg']);
  });
});

describe('isContentKind', () => {
  it('accepts exactly the three known kinds', () => {
    expect(['msg', 'evt', 'task'].every(isContentKind)).toBe(true);
    expect(isContentKind('drive')).toBe(false);
    expect(isContentKind(null)).toBe(false);
  });
});

describe('describeKinds', () => {
  it('names kinds the way the page does, in a stable order', () => {
    expect(describeKinds(['evt', 'msg'])).toBe('Email, Calendar');
  });

  it('never renders an empty reach as blank', () => {
    expect(describeKinds([])).toBe('Email');
  });
});
