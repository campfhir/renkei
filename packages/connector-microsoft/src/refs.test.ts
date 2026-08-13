/**
 * The refId scheme's contract: the owner is the FIRST segment, lowercased,
 * and remains readable regardless of what follows — kind, opaque id, or a
 * chunk suffix appended after the id.
 */

import { microsoftRefId, ownerOfMicrosoftRefId, objectIdOfMicrosoftRefId } from './refs';

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

describe('objectIdOfMicrosoftRefId', () => {
  it('recovers the Graph object id for every kind', () => {
    for (const kind of ['msg', 'evt', 'task'] as const) {
      const refId = microsoftRefId('sam@contoso.com', kind, 'AAMkAD=');
      expect(objectIdOfMicrosoftRefId(refId)).toBe('AAMkAD=');
    }
  });

  it('includes a chunk suffix if present — callers that want the bare id use the unchunked refId', () => {
    const refId = `${microsoftRefId('sam@contoso.com', 'msg', 'AAMkAD=')}#0001`;
    expect(objectIdOfMicrosoftRefId(refId)).toBe('AAMkAD=#0001');
  });

  it('returns null for malformed refs', () => {
    expect(objectIdOfMicrosoftRefId('no-separator')).toBeNull();
    expect(objectIdOfMicrosoftRefId('sam@contoso.com/msg')).toBeNull();
    expect(objectIdOfMicrosoftRefId('sam@contoso.com/msg/')).toBeNull();
    expect(objectIdOfMicrosoftRefId('')).toBeNull();
  });
});
