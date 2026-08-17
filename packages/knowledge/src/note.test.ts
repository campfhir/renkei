/**
 * The note verifier: pure authorship. Only the ref-prefix owner reads a
 * note; chunk suffixes and case differences never widen access.
 */

import { createNoteAccessVerifier, noteRefId, ownerOfNoteRefId } from './note';

const verifier = createNoteAccessVerifier();

function refs(...ids: string[]) {
  return ids.map((refId) => ({ provider: 'note', refId }));
}

test('refId encodes the lowercased owner; chunk suffixes leave it intact', () => {
  expect(noteRefId('Alice@Example.com', 'n-1')).toBe('alice@example.com/n-1');
  expect(ownerOfNoteRefId('alice@example.com/n-1')).toBe('alice@example.com');
  expect(ownerOfNoteRefId('alice@example.com/n-1#0002')).toBe('alice@example.com');
  expect(ownerOfNoteRefId('no-slash')).toBeNull();
});

test('the author reads their notes, case-insensitively', async () => {
  const result = await verifier.verifyAccess(
    'Alice@Example.com ',
    refs('alice@example.com/n-1', 'alice@example.com/n-2#0003')
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.val.map((r) => r.refId)).toEqual([
      'alice@example.com/n-1',
      'alice@example.com/n-2#0003',
    ]);
});

test("anyone else's notes are withheld, as is everything for a blank caller", async () => {
  const denied = await verifier.verifyAccess('bob@example.com', refs('alice@example.com/n-1'));
  expect(denied.ok && denied.val).toEqual([]);

  const blank = await verifier.verifyAccess('  ', refs('alice@example.com/n-1'));
  expect(blank.ok && blank.val).toEqual([]);
});
