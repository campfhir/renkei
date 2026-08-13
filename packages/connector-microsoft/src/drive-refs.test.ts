/**
 * The drive refId scheme: round-tripping, chunk-suffix tolerance, and the
 * malformed cases that must parse to null so the gate denies them.
 */

import {
  SHAREPOINT_KNOWLEDGE_PROVIDER,
  sharepointRefId,
  partsOfSharepointRefId,
} from './drive-refs';

describe('sharepointRefId', () => {
  it('joins drive and item, and round-trips', () => {
    const refId = sharepointRefId('b!aBcD-1234', '01ABCXYZ');
    expect(refId).toBe('b!aBcD-1234/01ABCXYZ');
    expect(partsOfSharepointRefId(refId)).toEqual({
      driveId: 'b!aBcD-1234',
      itemId: '01ABCXYZ',
    });
  });

  it('carries no owner segment — ownership is not the ACL for shared documents', () => {
    // The contrast with microsoftRefId is the whole point of this scheme: a
    // document indexed by one user is readable by others, so encoding the
    // indexer would answer the wrong question.
    expect(sharepointRefId('drive-1', 'item-1')).toBe('drive-1/item-1');
  });

  it('is the provider key the verifier registers under', () => {
    expect(SHAREPOINT_KNOWLEDGE_PROVIDER).toBe('sharepoint');
  });
});

describe('partsOfSharepointRefId', () => {
  it('strips the chunk suffix so a chunk resolves to its document', () => {
    expect(partsOfSharepointRefId('drive-1/item-1#0007')).toEqual({
      driveId: 'drive-1',
      itemId: 'item-1',
    });
  });

  it('splits on the FIRST separator, so an item id containing one survives', () => {
    expect(partsOfSharepointRefId('drive-1/a/b')).toEqual({
      driveId: 'drive-1',
      itemId: 'a/b',
    });
  });

  it.each([
    ['no separator', 'driveonly'],
    ['empty drive', '/item-1'],
    ['empty item', 'drive-1/'],
    ['empty string', ''],
    ['suffix only', '#0001'],
  ])('returns null for %s, which must deny downstream', (_label, refId) => {
    expect(partsOfSharepointRefId(refId)).toBeNull();
  });
});
