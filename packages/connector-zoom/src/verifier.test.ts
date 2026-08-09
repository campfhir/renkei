/**
 * The verifier's contract: the ref's host segment IS the ACL — the meeting
 * host owns the transcript, everyone else is denied, no network involved.
 */

import { createZoomAccessVerifier, hostOfZoomRefId, zoomRefId } from './verifier';

describe('zoomRefId / hostOfZoomRefId', () => {
  it('round-trips a host email with a uuid full of reserved characters', () => {
    const refId = zoomRefId('Host@Example.com', 'ab/cd==+e/f');
    expect(refId).toBe('host@example.com/ab/cd==+e/f');
    expect(hostOfZoomRefId(refId)).toBe('host@example.com');
  });

  it('splits on the FIRST slash only — later slashes belong to the uuid', () => {
    expect(hostOfZoomRefId('host@example.com//starts-with-slash==')).toBe('host@example.com');
  });

  it('is undisturbed by chunk suffixes appended after the uuid', () => {
    expect(hostOfZoomRefId('host@example.com/uu/id==#0001')).toBe('host@example.com');
    expect(hostOfZoomRefId('host@example.com/uu/id==#summary')).toBe('host@example.com');
  });

  it('lowercases the extracted host', () => {
    expect(hostOfZoomRefId('HOST@Example.COM/uuid==')).toBe('host@example.com');
  });

  it('answers null for refs with no host segment', () => {
    expect(hostOfZoomRefId('no-slash-at-all')).toBeNull();
    expect(hostOfZoomRefId('/leading-slash-empty-host')).toBeNull();
  });
});

describe('createZoomAccessVerifier', () => {
  const verifier = createZoomAccessVerifier();

  function ref(refId: string) {
    return { provider: 'zoom', refId };
  }

  it('allows exactly the refs whose host matches the user, case- and space-insensitively', async () => {
    const result = await verifier.verifyAccess('  Host@Example.COM ', [
      ref('host@example.com/uuid-1=='),
      ref('host@example.com/uu/id-2==#0001'),
      ref('other@example.com/uuid-3=='),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.map((r) => r.refId)).toEqual([
        'host@example.com/uuid-1==',
        'host@example.com/uu/id-2==#0001',
      ]);
    }
  });

  it('denies malformed refs and empty user ids', async () => {
    const malformed = await verifier.verifyAccess('host@example.com', [ref('no-host-part')]);
    if (malformed.ok) expect(malformed.val).toEqual([]);

    const anonymous = await verifier.verifyAccess('   ', [ref('host@example.com/uuid==')]);
    if (anonymous.ok) expect(anonymous.val).toEqual([]);
  });

  it('identifies itself as the zoom provider', () => {
    expect(verifier.provider).toBe('zoom');
  });
});
