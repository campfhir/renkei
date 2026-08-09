/**
 * The refId scheme's contract: the owner is the FIRST segment, lowercased,
 * and remains readable regardless of what follows — kind, opaque id, or a
 * chunk suffix appended after the id.
 */

import { microsoftRefId, ownerOfMicrosoftRefId } from './refs';

describe('microsoftRefId', () => {
  it('builds upn/kind/id with the UPN lowercased', () => {
    expect(microsoftRefId('Sam.Jones@Contoso.com', 'msg', 'AAMkAD=')).toBe(
      'sam.jones@contoso.com/msg/AAMkAD='
    );
  });
});

describe('ownerOfMicrosoftRefId', () => {
  it('round-trips the owner for every kind', () => {
    for (const kind of ['msg', 'evt', 'task'] as const) {
      const refId = microsoftRefId('sam@contoso.com', kind, 'id-1');
      expect(ownerOfMicrosoftRefId(refId)).toBe('sam@contoso.com');
    }
  });

  it('lowercases an uppercase UPN read from a foreign-built refId', () => {
    expect(ownerOfMicrosoftRefId('SAM@CONTOSO.COM/msg/id-1')).toBe('sam@contoso.com');
  });

  it('parses a chunk-suffixed refId identically — the suffix follows the id', () => {
    const refId = `${microsoftRefId('sam@contoso.com', 'msg', 'AAMkAD=')}#0001`;
    expect(ownerOfMicrosoftRefId(refId)).toBe('sam@contoso.com');
  });

  it('returns null for malformed refs', () => {
    expect(ownerOfMicrosoftRefId('no-separator')).toBeNull();
    expect(ownerOfMicrosoftRefId('/msg/id-1')).toBeNull();
    expect(ownerOfMicrosoftRefId('')).toBeNull();
  });
});
